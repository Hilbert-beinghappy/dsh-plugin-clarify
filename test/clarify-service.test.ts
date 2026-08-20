import { describe, expect, it } from 'vitest'
import { ClarifyError, DEFAULT_TTL_MS, type ClarifyQuestion, type HostBinding, type InferenceEngine } from '../src/types.ts'
import { ClarifyService } from '../src/clarify-service.ts'
import { STUB_QUESTIONS } from '../src/stub-inference.ts'

class MutableClock {
  current = 1_000_000
  now = (): number => this.current
}

function binding(overrides: Partial<HostBinding> = {}): HostBinding {
  return {
    sessionId: 'session-1',
    contextVersion: 'ctx-v1',
    modelRouteId: 'route-v1',
    ...overrides,
  }
}

function createService(options?: {
  clock?: MutableClock
  bindings?: Map<string, HostBinding>
  ttlMs?: number
  inference?: InferenceEngine
  onCancelInFlight?: (processId: string) => void
  idFactory?: () => string
}): { service: ClarifyService; clock: MutableClock; bindings: Map<string, HostBinding> } {
  const clock = options?.clock ?? new MutableClock()
  const bindings = options?.bindings ?? new Map([['session-1', binding()]])
  const service = new ClarifyService({
    now: () => clock.now(),
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    resolveBinding: (sessionId) => {
      const found = bindings.get(sessionId)
      if (!found) throw new ClarifyError('PROCESS_NOT_FOUND', `unknown session ${sessionId}`)
      return found
    },
    inference: options?.inference,
    onCancelInFlight: options?.onCancelInFlight,
    idFactory: options?.idFactory,
  })
  return { service, clock, bindings }
}

function createDeferredInference() {
  const inputs: Array<{
    history: Array<{ questionId: string; selectedOptionIds?: string[]; customText?: string }>
    currentQuestion?: { questionId: string }
  }> = []
  const pending: Array<{
    resolve: (result: import('../src/types.ts').InferenceResult) => void
    reject: (error: unknown) => void
  }> = []
  const inference: InferenceEngine = {
    async infer(input) {
      inputs.push({
        currentQuestion: input.currentQuestion ? { questionId: input.currentQuestion.questionId } : undefined,
        history: input.history.map((item) => ({
          questionId: item.questionId,
          ...item.selectedOptionIds === undefined ? {} : { selectedOptionIds: [...item.selectedOptionIds] },
          ...item.customText === undefined ? {} : { customText: item.customText },
        })),
      })
      if (Array.isArray(input.history)) {
        (input.history as Array<{ questionId: string }>).push({ questionId: 'mutated-by-engine' })
      }
      return await new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
      })
    },
  }
  async function waitForInfer(count: number): Promise<void> {
    for (let i = 0; i < 40 && inputs.length < count; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(inputs.length).toBeGreaterThanOrEqual(count)
  }
  return {
    inference,
    inputs,
    pending,
    waitForInfer,
    resolveNext(result: import('../src/types.ts').InferenceResult) {
      const next = pending.shift()
      if (!next) throw new Error('no pending infer')
      next.resolve(result)
    },
    rejectNext(error: unknown) {
      const next = pending.shift()
      if (!next) throw new Error('no pending infer')
      next.reject(error)
    },
  }
}

describe('ClarifyService TTL state machine', () => {
  it('start returns a process echo and the first question', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1', seedText: 'half-written ask' })
    expect(started.status).toBe('running')
    expect(started.sessionId).toBe('session-1')
    expect(started.contextVersion).toBe('ctx-v1')
    expect(started.modelRouteId).toBe('route-v1')
    expect(started.processId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(started.question).toEqual(STUB_QUESTIONS[0])
    expect(started).not.toHaveProperty('draft')
  })

  it('start requires sessionId', async () => {
    const { service } = createService()
    await expect(service.start({ sessionId: '' })).rejects.toMatchObject({
      code: 'SESSION_ID_REQUIRED',
    })
  })

  it('cancels the previous running process on the same session before creating a new one', async () => {
    const { service } = createService()
    const first = await service.start({ sessionId: 'session-1' })
    const second = await service.start({ sessionId: 'session-1' })
    expect(second.processId).not.toBe(first.processId)
    const cancelled = await service.cancel({ processId: first.processId })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.processId).toBe(first.processId)
  })

  it('rejects selectedOptionIds and customText together', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
      customText: 'also custom',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects empty selection', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: [],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('requires exactly one option when multiple is false', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature', 'o-bugfix'],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('requires at least one option when multiple is true', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const second = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(second.question?.multiple).toBe(true)
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      selectedOptionIds: [],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects customText when allowCustom is false', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const second = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(second.question?.allowCustom).toBe(false)
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      customText: 'nope',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('accepts customText when allowCustom is true and no options are sent', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const next = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      customText: 'ship a clarify plugin',
    })
    expect(next.status).toBe('running')
    expect(next.question?.questionId).toBe(STUB_QUESTIONS[1].questionId)
  })

  it('turns complete without returning draft; fetchDraft returns it separately', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1', seedText: 'need a plugin' })
    const q2 = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    const completed = await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      selectedOptionIds: ['o-compat', 'o-time'],
    })
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
    expect(completed).not.toHaveProperty('draft')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('complete')
    expect(fetched.draft).toContain('need a plugin')
    expect(fetched.draft).toContain('o-feature')
  })

  it('cleans up after draft is fetched once', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const q2 = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-bugfix'],
    })
    await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      selectedOptionIds: ['o-none'],
    })
    await service.fetchDraft({ processId: started.processId })
    await expect(service.fetchDraft({ processId: started.processId })).rejects.toMatchObject({
      code: 'PROCESS_NOT_FOUND',
    })
  })

  it('fetchDraft on running returns status without draft', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('running')
    expect(fetched.draft).toBeUndefined()
  })

  it('answer on complete returns complete and does not infer', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const q2 = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      selectedOptionIds: ['o-none'],
    })
    const again = await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      selectedOptionIds: ['o-time'],
    })
    expect(again.status).toBe('complete')
    expect(again.question).toBeUndefined()
  })

  it('cancel is idempotent and returns the existing terminal state', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const first = await service.cancel({ processId: started.processId })
    const second = await service.cancel({ processId: started.processId })
    expect(first.status).toBe('cancelled')
    expect(second.status).toBe('cancelled')
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(answered.status).toBe('cancelled')
    expect(answered.question).toBeUndefined()
  })

  it('invokes onCancelInFlight when cancelling a running process', async () => {
    const cancelled: string[] = []
    const { service } = createService({
      onCancelInFlight: (processId) => {
        cancelled.push(processId)
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    await service.cancel({ processId: started.processId })
    expect(cancelled).toEqual([started.processId])
  })

  it('TTL expiry marks stale with ttl-expired and drops question/draft', async () => {
    const { service, clock } = createService({ ttlMs: 1000 })
    const started = await service.start({ sessionId: 'session-1' })
    clock.current += 1001
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('ttl-expired')
    expect(answered.question).toBeUndefined()
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('stale')
    expect(fetched.staleReason).toBe('ttl-expired')
    expect(fetched.draft).toBeUndefined()
  })

  it('stale wins: answer and fetchDraft cannot consume question options or draft', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const stale = service.markStale(started.processId, 'compaction')
    expect(stale.status).toBe('stale')
    expect(stale.staleReason).toBe('compaction')
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('compaction')
    expect(answered.question).toBeUndefined()
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
    expect(fetched.staleReason).toBe('compaction')
  })

  it('marks each documented staleReason', async () => {
    const reasons = [
      'session-changed',
      'route-changed',
      'context-changed',
      'new-official-message',
      'compaction',
      'recall-injection',
      'ttl-expired',
    ] as const
    for (const reason of reasons) {
      const { service } = createService()
      const started = await service.start({ sessionId: 'session-1' })
      const stale = service.markStale(started.processId, reason)
      expect(stale.status).toBe('stale')
      expect(stale.staleReason).toBe(reason)
    }
  })

  it('binding route change on answer marks route-changed stale', async () => {
    const { service, bindings } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ modelRouteId: 'route-v2' }))
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('route-changed')
  })

  it('binding context change on answer marks context-changed stale', async () => {
    const { service, bindings } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('context-changed')
  })

  it('complete processes can still become stale and then lose draft', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const q2 = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      selectedOptionIds: ['o-none'],
    })
    const stale = service.markStale(started.processId, 'new-official-message')
    expect(stale.status).toBe('stale')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
    expect(fetched.staleReason).toBe('new-official-message')
  })

  it('unknown processId throws PROCESS_NOT_FOUND', async () => {
    const { service } = createService()
    await expect(service.cancel({ processId: 'missing' })).rejects.toMatchObject({
      code: 'PROCESS_NOT_FOUND',
    })
  })

  it('rejects duplicate selectedOptionIds', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const second = await service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      selectedOptionIds: ['o-compat', 'o-compat'],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects inference questions with duplicate or empty optionIds and does not publish them', async () => {
    const inference: InferenceEngine = {
      async infer() {
        return {
          kind: 'question',
          question: {
            questionId: 'q-bad',
            text: 'broken',
            options: [
              { optionId: 'dup', text: 'A' },
              { optionId: 'dup', text: 'B' },
            ],
            multiple: false,
            allowCustom: false,
          },
        }
      },
    }
    const { service } = createService({ inference })
    await expect(service.start({ sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
    })
    expect(service.runningProcessIds()).toEqual([])
  })

  it('re-checks binding after start inference so stale wins over a late question', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inference: InferenceEngine = {
      async infer() {
        await gate
        return { kind: 'question', question: STUB_QUESTIONS[0] }
      },
    }
    const { service, bindings } = createService({ inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    bindings.set('session-1', binding({ modelRouteId: 'route-v2' }))
    release()
    const started = await startedPromise
    expect(started.status).toBe('stale')
    expect(started.staleReason).toBe('route-changed')
    expect(started.question).toBeUndefined()
  })

  it('re-checks binding after answer inference so a late draft is not published', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) return { kind: 'question', question: STUB_QUESTIONS[0] }
        await gate
        return { kind: 'draft', draft: 'should-not-publish' }
      },
    }
    const { service, bindings } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    const answerPromise = service.answer({
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    release()
    const answered = await answerPromise
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('context-changed')
    expect(answered.question).toBeUndefined()
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
    expect(fetched.staleReason).toBe('context-changed')
  })

  it('abort in-flight inference on cancel', async () => {
    let sawAbort = false
    const inference: InferenceEngine = {
      async infer(_input, signal) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000)
          signal.addEventListener('abort', () => {
            sawAbort = true
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
        return { kind: 'question', question: STUB_QUESTIONS[0] }
      },
    }
    const { service } = createService({ inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const running = [...service.runningProcessIds()]
    expect(running).toHaveLength(1)
    await service.cancel({ processId: running[0]! })
    await expect(startedPromise).resolves.toMatchObject({ status: 'cancelled' })
    expect(sawAbort).toBe(true)
  })
})

describe('ClarifyService single-flight and inference failure hygiene', () => {
  it('rejects a second concurrent answer with PROCESS_BUSY and only infers once', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[0] })
    const started = await startedPromise

    const first = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    const second = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-bugfix'],
    })
    await deferred.waitForInfer(2)
    expect(deferred.inputs).toHaveLength(2)
    expect(deferred.inputs[1]?.history).toEqual([
      { questionId: 'q-goal', selectedOptionIds: ['o-feature'] },
    ])
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[1] })
    const settled = await Promise.allSettled([first, second])
    const rejected = settled.filter((item) => item.status === 'rejected')
    const fulfilled = settled.filter((item) => item.status === 'fulfilled')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'PROCESS_BUSY' } })
    expect(fulfilled).toHaveLength(1)
    if (fulfilled[0]?.status === 'fulfilled') {
      expect(fulfilled[0].value.question?.questionId).toBe('q-constraints')
    }

    const retry = service.answer({
      processId: started.processId,
      questionId: 'q-constraints',
      selectedOptionIds: ['o-compat'],
    })
    await deferred.waitForInfer(3)
    expect(deferred.inputs[2]?.history.map((item) => item.questionId)).toEqual(['q-goal', 'q-constraints'])
    expect(deferred.inputs[2]?.history.some((item) => item.questionId === 'mutated-by-engine')).toBe(false)
    deferred.resolveNext({ kind: 'draft', draft: 'ok' })
    await retry
  })

  it('rolls back a transient answer error so the current question can be retried once', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[0] })
    const started = await startedPromise

    const failed = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await deferred.waitForInfer(2)
    deferred.rejectNext(new Error('generic inference failure'))
    await expect(failed).rejects.toThrow(/generic inference failure/)
    expect(service.runningProcessIds()).toEqual([started.processId])

    const retry = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await deferred.waitForInfer(3)
    expect(deferred.inputs[2]?.history).toEqual([
      { questionId: 'q-goal', selectedOptionIds: ['o-feature'] },
    ])
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[1] })
    const answered = await retry
    expect(answered.status).toBe('running')
    expect(answered.question?.questionId).toBe('q-constraints')
  })

  it('lets cancel win during an in-flight answer and does not publish or resurrect', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[0] })
    const started = await startedPromise

    const inFlight = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await deferred.waitForInfer(2)
    const cancelled = await service.cancel({ processId: started.processId })
    expect(cancelled.status).toBe('cancelled')
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[1] })
    const late = await inFlight
    expect(late.status).toBe('cancelled')
    expect(late.question).toBeUndefined()
    const again = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(again.status).toBe('cancelled')
    expect(again.question).toBeUndefined()
    expect(service.runningProcessIds()).toEqual([])
  })

  it('lets stale win during an in-flight answer and does not publish a late draft', async () => {
    const deferred = createDeferredInference()
    const { service, bindings } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[0] })
    const started = await startedPromise

    const inFlight = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    await deferred.waitForInfer(2)
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    deferred.resolveNext({ kind: 'draft', draft: 'should-not-publish' })
    await expect(inFlight).resolves.toMatchObject({
      status: 'stale',
      staleReason: 'context-changed',
    })
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
    expect(fetched.status).toBe('stale')
    const again = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(again.status).toBe('stale')
    expect(again.question).toBeUndefined()
  })

  it('cleans up an unreachable start process when inference throws before returning', async () => {
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) throw new Error('start boom')
        return { kind: 'question', question: STUB_QUESTIONS[0] }
      },
    }
    const { service } = createService({
      inference,
      idFactory: () => 'proc-orphan',
    })
    await expect(service.start({ sessionId: 'session-1' })).rejects.toThrow(/start boom/)
    expect(service.runningProcessIds()).toEqual([])
    await expect(service.cancel({ processId: 'proc-orphan' })).rejects.toMatchObject({
      code: 'PROCESS_NOT_FOUND',
    })
    const again = await service.start({ sessionId: 'session-1' })
    expect(again.processId).toBe('proc-orphan')
    expect(again.status).toBe('running')
  })

  it('terminates the process when answer inference returns an invalid question', async () => {
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) return { kind: 'question', question: STUB_QUESTIONS[0] }
        return {
          kind: 'question',
          question: {
            questionId: 'q-bad',
            text: 'broken',
            options: [
              { optionId: 'dup', text: 'A' },
              { optionId: 'dup', text: 'B' },
            ],
            multiple: false,
            allowCustom: false,
          },
        }
      },
    }
    const { service } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect(service.runningProcessIds()).toEqual([])
    const again = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(again.status).toBe('cancelled')
    expect(again.question).toBeUndefined()
  })

  it.each([
    ['XOR conflict', {
      questionId: 'q-goal',
      selectedOptionIds: ['o-feature'],
      customText: 'also custom',
    }],
    ['empty selection', {
      questionId: 'q-goal',
      selectedOptionIds: [],
    }],
    ['wrong questionId', {
      questionId: 'q-not-current',
      selectedOptionIds: ['o-feature'],
    }],
    ['empty customText', {
      questionId: 'q-goal',
      customText: '   ',
    }],
  ] as const)('keeps the process running after user INVALID_ANSWER: %s', async (_label, bad) => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      ...bad,
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect(service.runningProcessIds()).toEqual([started.processId])
    const continued = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(continued.status).toBe('running')
    expect(continued.question?.questionId).toBe('q-constraints')
  })

  it('does not let a caller mutate started.question and corrupt the running process', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    started.question!.questionId = 'mutated-by-caller'
    started.question!.options[0] = { optionId: 'mutated', text: 'mutated' }
    const continued = await service.answer({
      processId: started.processId,
      questionId: 'q-goal',
      selectedOptionIds: ['o-feature'],
    })
    expect(continued.status).toBe('running')
    expect(continued.question?.questionId).toBe('q-constraints')
  })

  it('does not let a caller mutate the next answer question and corrupt the running process', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const next = await service.answer({
      processId: started.processId,
      questionId: 'q-goal',
      selectedOptionIds: ['o-feature'],
    })
    next.question!.questionId = 'mutated-by-caller'
    next.question!.options[0] = { optionId: 'mutated', text: 'mutated' }
    const completed = await service.answer({
      processId: started.processId,
      questionId: 'q-constraints',
      selectedOptionIds: ['o-compat'],
    })
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
  })

  it('clones a published question so later engine mutation cannot change the current question', async () => {
    const leaked: ClarifyQuestion = {
      questionId: 'q-goal',
      text: 'What is the main thing you want to accomplish?',
      options: [
        { optionId: 'o-feature', text: 'Add a feature' },
        { optionId: 'o-bugfix', text: 'Fix a bug' },
      ],
      multiple: false,
      allowCustom: true,
    }
    const inference: InferenceEngine = {
      async infer(input) {
        if (input.history.length === 0) return { kind: 'question', question: leaked }
        return { kind: 'question', question: STUB_QUESTIONS[1] }
      },
    }
    const { service } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    leaked.questionId = 'mutated-after-publish'
    leaked.options[0] = { optionId: 'mutated', text: 'mutated' }
    const continued = await service.answer({
      processId: started.processId,
      questionId: 'q-goal',
      selectedOptionIds: ['o-feature'],
    })
    expect(continued.status).toBe('running')
    expect(continued.question?.questionId).toBe('q-constraints')
    expect(started.question?.questionId).toBe('q-goal')
    expect(started.question?.options[0]?.optionId).toBe('o-feature')
  })

  it('rejects answer during in-flight start with PROCESS_BUSY', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({
      inference: deferred.inference,
      idFactory: () => 'proc-start',
    })
    const started = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    await expect(service.answer({
      processId: 'proc-start',
      questionId: 'q-goal',
      selectedOptionIds: ['o-feature'],
    })).rejects.toMatchObject({ code: 'PROCESS_BUSY' })
    deferred.resolveNext({ kind: 'question', question: STUB_QUESTIONS[0] })
    await expect(started).resolves.toMatchObject({ status: 'running', processId: 'proc-start' })
  })
})

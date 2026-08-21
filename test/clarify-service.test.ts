import { describe, expect, it } from 'vitest'
import { ClarifyError, DEFAULT_TTL_MS, type ClarifyQuestion, type HostBinding, type InferenceEngine, type ModelInference } from '../src/types.ts'
import { ClarifyService } from '../src/clarify-service.ts'
import { STUB_ASKS, StubInferenceEngine } from './fixtures/stub-inference.mjs'

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
      if (!found) throw new ClarifyError('PROCESS_NOT_FOUND', `unknown session ${sessionId}`, 'protocol')
      return found
    },
    inference: options?.inference ?? new StubInferenceEngine(),
    onCancelInFlight: options?.onCancelInFlight,
    idFactory: options?.idFactory,
  })
  return { service, clock, bindings }
}

function optionIdByText(question: ClarifyQuestion, text: string): string {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

function answerArgs(
  echo: { processId: string; question?: ClarifyQuestion; previewVersion?: string },
  texts: string[],
): { processId: string; questionId: string; previewVersion: string; selectedOptionIds: string[] } {
  return {
    processId: echo.processId,
    questionId: echo.question!.questionId,
    previewVersion: echo.previewVersion!,
    selectedOptionIds: texts.map((text) => optionIdByText(echo.question!, text)),
  }
}

function createDeferredInference() {
  const inputs: Array<{
    acceptedDecisions: Array<Record<string, unknown>>
  }> = []
  const pending: Array<{
    resolve: (result: ModelInference) => void
    reject: (error: unknown) => void
  }> = []
  const inference: InferenceEngine = {
    async infer(input) {
      inputs.push({
        acceptedDecisions: input.acceptedDecisions.map((item) => structuredClone(item) as Record<string, unknown>),
      })
      if (Array.isArray(input.acceptedDecisions)) {
        (input.acceptedDecisions as Array<{ questionId: string }>).push({ questionId: 'mutated-by-engine' })
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
    resolveNext(result: ModelInference) {
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

async function completeViaAnswers(service: ClarifyService, seedText?: string) {
  const started = await service.start({ sessionId: 'session-1', ...seedText === undefined ? {} : { seedText } })
  const q2 = await service.answer(answerArgs(started, ['Add a feature']))
  const ready = await service.answer(answerArgs(q2, ['Compatibility', 'Timeboxed']))
  const completed = await service.accept({
    processId: started.processId,
    previewVersion: ready.previewVersion!,
  })
  return { started, q2, ready, completed }
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
    expect(started.previewVersion).toMatch(/^[0-9a-f-]{36}$/i)
    expect(started.kind).toBe('ask')
    expect(started.question?.text).toBe(STUB_ASKS[0]!.question)
    expect(started.question?.options.map((option) => option.text)).toEqual([...STUB_ASKS[0]!.options])
    expect(started.draftPreview).toBe(STUB_ASKS[0]!.draftPreview)
    expect(started.materialChanges).toEqual(STUB_ASKS[0]!.materialChanges)
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
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionIdByText(started.question!, 'Add a feature')],
      customText: 'also custom',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects empty selection', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('requires exactly one option when multiple is false', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [
        optionIdByText(started.question!, 'Add a feature'),
        optionIdByText(started.question!, 'Fix a bug'),
      ],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('requires at least one option when multiple is true', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const second = await service.answer(answerArgs(started, ['Add a feature']))
    expect(second.question?.multiple).toBe(true)
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      previewVersion: second.previewVersion!,
      selectedOptionIds: [],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects customText when allowCustom is false', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const second = await service.answer(answerArgs(started, ['Add a feature']))
    expect(second.question?.allowCustom).toBe(false)
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      previewVersion: second.previewVersion!,
      customText: 'nope',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('accepts customText when allowCustom is true and no options are sent', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const next = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      customText: 'ship a clarify plugin',
    })
    expect(next.status).toBe('running')
    expect(next.question?.text).toBe(STUB_ASKS[1]!.question)
  })

  it('turns complete without returning draft; fetchDraft returns it separately', async () => {
    const { service } = createService()
    const { started, completed } = await completeViaAnswers(service, 'need a plugin')
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
    expect(completed).not.toHaveProperty('draft')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('complete')
    expect(fetched.draft).toContain('need a plugin')
    expect(fetched.draft).toContain('Add a feature')
  })

  it('keeps fetchDraft idempotent until the tombstone TTL', async () => {
    const { service } = createService()
    const { started } = await completeViaAnswers(service)
    const first = await service.fetchDraft({ processId: started.processId })
    const second = await service.fetchDraft({ processId: started.processId })
    expect(first.draft).toBe(second.draft)
    expect(typeof first.draft).toBe('string')
  })

  it('fetchDraft on running returns the complete published state without draft', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched).toEqual(started)
    expect(fetched).toMatchObject({
      status: 'running',
      kind: 'ask',
      previewVersion: started.previewVersion,
      draftPreview: started.draftPreview,
      materialChanges: started.materialChanges,
      question: started.question,
    })
    expect(fetched).not.toHaveProperty('draft')
  })

  it('answer on complete returns complete and does not infer', async () => {
    const { service } = createService()
    const { started, q2 } = await completeViaAnswers(service)
    const again = await service.answer({
      processId: started.processId,
      questionId: q2.question!.questionId,
      previewVersion: q2.previewVersion!,
      selectedOptionIds: [optionIdByText(q2.question!, 'Timeboxed')],
    })
    expect(again.status).toBe('complete')
    expect(again.question).toBeUndefined()
    expect(again).not.toHaveProperty('draft')
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
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionIdByText(started.question!, 'Add a feature')],
    })
    expect(answered.status).toBe('cancelled')
    expect(answered.question).toBeUndefined()
    expect(answered).not.toHaveProperty('draft')
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

  it('bulk cancellation aborts every process even when an observer throws', async () => {
    const cancelled: string[] = []
    const { service, bindings } = createService({
      onCancelInFlight: (processId) => {
        cancelled.push(processId)
        throw new Error('observer failed')
      },
    })
    bindings.set('session-2', binding({ sessionId: 'session-2' }))
    const first = await service.start({ sessionId: 'session-1' })
    const second = await service.start({ sessionId: 'session-2' })

    expect(() => service.cancelAllRunning()).not.toThrow()
    expect(service.runningProcessIds()).toEqual([])
    await expect(service.fetchDraft({ processId: first.processId })).resolves.toMatchObject({ status: 'cancelled' })
    await expect(service.fetchDraft({ processId: second.processId })).resolves.toMatchObject({ status: 'cancelled' })
    expect(cancelled).toEqual([first.processId, second.processId])
  })

  it('TTL expiry marks stale with ttl-expired and drops question/draft', async () => {
    const { service, clock } = createService({ ttlMs: 1000 })
    const started = await service.start({ sessionId: 'session-1' })
    clock.current += 1001
    const answered = await service.answer(answerArgs(started, ['Add a feature']))
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
    const answered = await service.answer(answerArgs(started, ['Add a feature']))
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
    const answered = await service.answer(answerArgs(started, ['Add a feature']))
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('route-changed')
  })

  it('binding context change on answer marks context-changed stale', async () => {
    const { service, bindings } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    const answered = await service.answer(answerArgs(started, ['Add a feature']))
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('context-changed')
  })

  it('freezes a completed tombstone and draft against later binding invalidation', async () => {
    const { service, bindings } = createService()
    const { started, ready, completed } = await completeViaAnswers(service)
    expect(completed.status).toBe('complete')
    bindings.set('session-1', binding({ contextVersion: 'ctx-after-accept' }))
    const unchanged = service.markStale(started.processId, 'new-official-message')
    expect(unchanged.status).toBe('complete')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('complete')
    expect(fetched.draft).toBe(ready.draftPreview)
    expect(fetched.staleReason).toBeUndefined()
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
    const second = await service.answer(answerArgs(started, ['Add a feature']))
    const optionId = optionIdByText(second.question!, 'Compatibility')
    await expect(service.answer({
      processId: started.processId,
      questionId: second.question!.questionId,
      previewVersion: second.previewVersion!,
      selectedOptionIds: [optionId, optionId],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('rejects inference asks with duplicate option texts and does not publish them', async () => {
    const inference: InferenceEngine = {
      async infer() {
        return {
          kind: 'ask',
          question: 'broken',
          options: ['A', 'A'],
          multiple: false,
          allowCustom: false,
          draftPreview: 'bad preview',
          materialChanges: ['invalid'],
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
        return STUB_ASKS[0]!
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

  it('re-checks binding after answer inference so a late preview is not published', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) return STUB_ASKS[0]!
        await gate
        return { kind: 'await_accept', draftPreview: 'should-not-publish', materialChanges: ['late'] }
      },
    }
    const { service, bindings } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    const answerPromise = service.answer(answerArgs(started, ['Add a feature']))
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
        return STUB_ASKS[0]!
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
    deferred.resolveNext(STUB_ASKS[0]!)
    const started = await startedPromise

    const first = service.answer(answerArgs(started, ['Add a feature']))
    const second = service.answer(answerArgs(started, ['Fix a bug']))
    await deferred.waitForInfer(2)
    expect(deferred.inputs).toHaveLength(2)
    expect(deferred.inputs[1]?.acceptedDecisions).toEqual([
      {
        questionText: STUB_ASKS[0]!.question,
        answer: 'selected_options',
        selectedOptionTexts: ['Add a feature'],
      },
    ])
    deferred.resolveNext(STUB_ASKS[1]!)
    const settled = await Promise.allSettled([first, second])
    const rejected = settled.filter((item) => item.status === 'rejected')
    const fulfilled = settled.filter((item) => item.status === 'fulfilled')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { code: 'PROCESS_BUSY' } })
    expect(fulfilled).toHaveLength(1)
    if (fulfilled[0]?.status === 'fulfilled') {
      expect(fulfilled[0].value.question?.text).toBe(STUB_ASKS[1]!.question)
    }

    const next = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined
    const retry = service.answer(answerArgs(next!, ['Compatibility']))
    await deferred.waitForInfer(3)
    expect(deferred.inputs[2]?.acceptedDecisions).toEqual([
      {
        questionText: STUB_ASKS[0]!.question,
        answer: 'selected_options',
        selectedOptionTexts: ['Add a feature'],
      },
      {
        questionText: STUB_ASKS[1]!.question,
        answer: 'selected_options',
        selectedOptionTexts: ['Compatibility'],
      },
    ])
    expect(JSON.stringify(deferred.inputs[2]?.acceptedDecisions)).not.toContain('mutated-by-engine')
    deferred.resolveNext({
      kind: 'await_accept',
      draftPreview: 'ok materially different draft body',
      materialChanges: ['closed'],
    })
    await retry
  })

  it('rolls back a transient answer error so the current question can be retried once', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext(STUB_ASKS[0]!)
    const started = await startedPromise

    const failed = service.answer(answerArgs(started, ['Add a feature']))
    await deferred.waitForInfer(2)
    deferred.rejectNext(new Error('generic inference failure'))
    await expect(failed).rejects.toThrow(/generic inference failure/)
    expect(service.runningProcessIds()).toEqual([started.processId])

    const retry = service.answer(answerArgs(started, ['Add a feature']))
    await deferred.waitForInfer(3)
    expect(deferred.inputs[2]?.acceptedDecisions).toEqual([
      {
        questionText: STUB_ASKS[0]!.question,
        answer: 'selected_options',
        selectedOptionTexts: ['Add a feature'],
      },
    ])
    deferred.resolveNext(STUB_ASKS[1]!)
    const answered = await retry
    expect(answered.status).toBe('running')
    expect(answered.question?.text).toBe(STUB_ASKS[1]!.question)
  })

  it('lets cancel win during an in-flight answer and does not publish or resurrect', async () => {
    const deferred = createDeferredInference()
    const { service } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext(STUB_ASKS[0]!)
    const started = await startedPromise

    const inFlight = service.answer(answerArgs(started, ['Add a feature']))
    await deferred.waitForInfer(2)
    const cancelled = await service.cancel({ processId: started.processId })
    expect(cancelled.status).toBe('cancelled')
    deferred.resolveNext(STUB_ASKS[1]!)
    const late = await inFlight
    expect(late.status).toBe('cancelled')
    expect(late.question).toBeUndefined()
    expect(late).not.toHaveProperty('draft')
    const again = await service.answer(answerArgs(started, ['Add a feature']))
    expect(again.status).toBe('cancelled')
    expect(again.question).toBeUndefined()
    expect(service.runningProcessIds()).toEqual([])
  })

  it('lets stale win during an in-flight answer and does not publish a late draft', async () => {
    const deferred = createDeferredInference()
    const { service, bindings } = createService({ inference: deferred.inference })
    const startedPromise = service.start({ sessionId: 'session-1' })
    await deferred.waitForInfer(1)
    deferred.resolveNext(STUB_ASKS[0]!)
    const started = await startedPromise

    const inFlight = service.answer(answerArgs(started, ['Add a feature']))
    await deferred.waitForInfer(2)
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    deferred.resolveNext({
      kind: 'await_accept',
      draftPreview: 'should-not-publish',
      materialChanges: ['late'],
    })
    await expect(inFlight).resolves.toMatchObject({
      status: 'stale',
      staleReason: 'context-changed',
    })
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
    expect(fetched.status).toBe('stale')
    const again = await service.answer(answerArgs(started, ['Add a feature']))
    expect(again.status).toBe('stale')
    expect(again.question).toBeUndefined()
  })

  it('cleans up an unreachable start process when inference throws before returning', async () => {
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) throw new Error('start boom')
        return STUB_ASKS[0]!
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

  it('keeps the process running when answer inference returns an invalid ask', async () => {
    let calls = 0
    const inference: InferenceEngine = {
      async infer() {
        calls += 1
        if (calls === 1) return STUB_ASKS[0]!
        if (calls === 2) {
          return {
            kind: 'ask',
            question: 'broken',
            options: ['A', 'A'],
            multiple: false,
            allowCustom: false,
            draftPreview: 'broken preview',
            materialChanges: ['invalid'],
          }
        }
        return STUB_ASKS[1]!
      },
    }
    const { service } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.answer(answerArgs(started, ['Add a feature']))).rejects.toMatchObject({
      code: 'INVALID_ANSWER',
    })
    expect(service.runningProcessIds()).toEqual([started.processId])
    const again = await service.answer(answerArgs(started, ['Add a feature']))
    expect(again.status).toBe('running')
    expect(again.question?.text).toBe(STUB_ASKS[1]!.question)
    expect(again.previewVersion).not.toBe(started.previewVersion)
  })

  it.each([
    ['XOR conflict', {
      selectedOptionIds: ['placeholder'],
      customText: 'also custom',
    }],
    ['empty selection', {
      selectedOptionIds: [],
    }],
    ['wrong questionId', {
      questionId: 'q-not-current',
      selectedOptionIds: ['placeholder'],
    }],
    ['empty customText', {
      customText: '   ',
    }],
  ] as const)('keeps the process running after user INVALID_ANSWER: %s', async (_label, bad) => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const selected = bad.selectedOptionIds
      ? bad.selectedOptionIds[0] === 'placeholder'
        ? [optionIdByText(started.question!, 'Add a feature')]
        : [...bad.selectedOptionIds]
      : undefined
    await expect(service.answer({
      processId: started.processId,
      questionId: 'questionId' in bad ? bad.questionId : started.question!.questionId,
      previewVersion: started.previewVersion!,
      ...selected === undefined ? {} : { selectedOptionIds: selected },
      ...'customText' in bad ? { customText: bad.customText } : {},
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect(service.runningProcessIds()).toEqual([started.processId])
    const continued = await service.answer(answerArgs(started, ['Add a feature']))
    expect(continued.status).toBe('running')
    expect(continued.question?.text).toBe(STUB_ASKS[1]!.question)
  })

  it('does not let a caller mutate started.question and corrupt the running process', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const questionId = started.question!.questionId
    const optionId = optionIdByText(started.question!, 'Add a feature')
    const previewVersion = started.previewVersion!
    started.question!.questionId = 'mutated-by-caller'
    started.question!.options[0] = { optionId: 'mutated', text: 'mutated' }
    const continued = await service.answer({
      processId: started.processId,
      questionId,
      previewVersion,
      selectedOptionIds: [optionId],
    })
    expect(continued.status).toBe('running')
    expect(continued.question?.text).toBe(STUB_ASKS[1]!.question)
  })

  it('does not let a caller mutate the next answer question and corrupt the running process', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const next = await service.answer(answerArgs(started, ['Add a feature']))
    const questionId = next.question!.questionId
    const optionId = optionIdByText(next.question!, 'Compatibility')
    const previewVersion = next.previewVersion!
    next.question!.questionId = 'mutated-by-caller'
    next.question!.options[0] = { optionId: 'mutated', text: 'mutated' }
    const ready = await service.answer({
      processId: started.processId,
      questionId,
      previewVersion,
      selectedOptionIds: [optionId],
    })
    expect(ready.status).toBe('running')
    expect(ready.question).toBeUndefined()
    const completed = await service.accept({
      processId: started.processId,
      previewVersion: ready.previewVersion!,
    })
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
  })

  it('clones a published ask so later engine mutation cannot change the current question', async () => {
    const leaked: ModelInference = {
      kind: 'ask',
      question: 'What is the main thing you want to accomplish?',
      options: ['Add a feature', 'Fix a bug'],
      multiple: false,
      allowCustom: true,
      draftPreview: 'User draft pending first answer.',
      materialChanges: ['opened'],
    }
    const inference: InferenceEngine = {
      async infer(input) {
        if (input.acceptedDecisions.length === 0) return leaked
        return STUB_ASKS[1]!
      },
    }
    const { service } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    if (leaked.kind === 'ask') {
      leaked.question = 'mutated-after-publish'
      leaked.options[0] = 'mutated'
    }
    const continued = await service.answer(answerArgs(started, ['Add a feature']))
    expect(continued.status).toBe('running')
    expect(continued.question?.text).toBe(STUB_ASKS[1]!.question)
    expect(started.question?.text).toBe('What is the main thing you want to accomplish?')
    expect(started.question?.options[0]?.text).toBe('Add a feature')
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
      previewVersion: 'missing',
      selectedOptionIds: ['o-feature'],
    })).rejects.toMatchObject({ code: 'PROCESS_BUSY' })
    deferred.resolveNext(STUB_ASKS[0]!)
    await expect(started).resolves.toMatchObject({ status: 'running', processId: 'proc-start' })
  })
})

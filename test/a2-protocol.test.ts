import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import { ClarifyService } from '../src/clarify-service.ts'
import { ClarifyError, DEFAULT_TTL_MS, type HostBinding, type InferenceEngine, type ModelInference } from '../src/types.ts'

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

function ask(overrides: Partial<Extract<ModelInference, { kind: 'ask' }>> = {}): Extract<ModelInference, { kind: 'ask' }> {
  return {
    kind: 'ask',
    question: overrides.question ?? 'What is the main thing you want to accomplish?',
    options: overrides.options ?? ['Add a feature', 'Fix a bug'],
    multiple: overrides.multiple ?? false,
    allowCustom: overrides.allowCustom ?? true,
    draftPreview: overrides.draftPreview ?? 'Initial user draft toward a clarify plugin.',
    materialChanges: overrides.materialChanges ?? ['opened the first question'],
  }
}

function awaitAccept(overrides: Partial<Extract<ModelInference, { kind: 'await_accept' }>> = {}): Extract<ModelInference, { kind: 'await_accept' }> {
  return {
    kind: 'await_accept',
    draftPreview: overrides.draftPreview ?? 'Final user draft for a clarify Host plugin.',
    materialChanges: overrides.materialChanges ?? ['resolved remaining choices'],
  }
}

function createService(options?: {
  clock?: MutableClock
  ttlMs?: number
  inference?: InferenceEngine
  onCancelInFlight?: (processId: string) => void
  idFactory?: () => string
  opaqueIdFactory?: () => string
}): { service: ClarifyService; clock: MutableClock; bindings: Map<string, HostBinding>; inputs: Array<{
  acceptedDecisions: readonly unknown[]
  raw: string
}> } {
  const clock = options?.clock ?? new MutableClock()
  const bindings = new Map([['session-1', binding()]])
  const inputs: Array<{ acceptedDecisions: readonly unknown[]; raw: string }> = []
  const inference = options?.inference ?? {
    async infer(input) {
      inputs.push({ acceptedDecisions: input.acceptedDecisions, raw: JSON.stringify(input) })
      if (input.acceptedDecisions.length === 0) return ask()
      if (input.acceptedDecisions.length === 1) {
        return ask({
          question: 'Which constraints should the draft respect?',
          options: ['Timeboxed', 'Compatibility'],
          multiple: true,
          allowCustom: false,
          draftPreview: 'User draft: add a feature with named constraints still open.',
          materialChanges: ['recorded the goal'],
        })
      }
      return awaitAccept()
    },
  }
  const service = new ClarifyService({
    now: () => clock.now(),
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    resolveBinding: (sessionId) => {
      const found = bindings.get(sessionId)
      if (!found) throw new ClarifyError('PROCESS_NOT_FOUND', `unknown session ${sessionId}`, 'protocol')
      return found
    },
    inference,
    onCancelInFlight: options?.onCancelInFlight,
    idFactory: options?.idFactory,
    opaqueIdFactory: options?.opaqueIdFactory,
  })
  return { service, clock, bindings, inputs }
}

function optionId(question: { options: Array<{ optionId: string; text: string }> }, text: string): string {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

async function reachAwaitAccept(
  service: ClarifyService,
  started: Awaited<ReturnType<ClarifyService['start']>>,
): Promise<Awaited<ReturnType<ClarifyService['start']>>> {
  let current = started
  while (current.status === 'running' && current.kind === 'ask') {
    const question = current.question
    if (!question || !current.previewVersion || question.options.length === 0) {
      throw new Error('test process is missing a selectable published question')
    }
    current = await service.answer({
      processId: current.processId,
      questionId: question.questionId,
      previewVersion: current.previewVersion,
      selectedOptionIds: [question.options[0]!.optionId],
    })
  }
  if (current.status !== 'running' || current.kind !== 'await_accept') {
    throw new Error(`test process did not reach await_accept: ${current.status}`)
  }
  return current
}

describe('Clarify A2 Host IDs and text-only model history', () => {
  it('lets Host assign opaque IDs and never sends those IDs to the model', async () => {
    const { service, inputs } = createService()
    const started = await service.start({ sessionId: 'session-1', seedText: 'half-written ask' })
    expect(started.status).toBe('running')
    expect(started.kind).toBe('ask')
    expect(started.previewVersion).toMatch(/^[0-9a-f-]{36}$/i)
    expect(started.question?.questionId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(started.question?.options.every((option) => /^[0-9a-f-]{36}$/i.test(option.optionId))).toBe(true)
    expect(started.draftPreview).toBe('Initial user draft toward a clarify plugin.')
    expect(started.materialChanges).toEqual(['opened the first question'])
    expect(started).not.toHaveProperty('draft')

    const next = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })
    expect(next.status).toBe('running')
    expect(next.kind).toBe('ask')
    expect(next.materialChanges).toEqual(['recorded the goal'])
    expect(next.previewVersion).toBeTruthy()
    expect(next.previewVersion).not.toBe(started.previewVersion)
    expect(inputs[1]?.acceptedDecisions).toEqual([{
      questionText: 'What is the main thing you want to accomplish?',
      answer: 'selected_options',
      selectedOptionTexts: ['Add a feature'],
    }])
    expect(inputs[1]?.raw).not.toContain(started.question!.questionId)
    expect(inputs[1]?.raw).not.toContain(started.previewVersion)
    expect(inputs[1]?.raw).not.toContain(optionId(started.question!, 'Add a feature'))
    expect(inputs[1]?.raw).not.toMatch(/questionId|optionId|previewVersion|processId/)
  })

  it('sends custom text, never option IDs, when allowCustom wins the XOR', async () => {
    const { service, inputs } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      customText: 'ship a clarify plugin',
    })
    expect(inputs[1]?.acceptedDecisions).toEqual([{
      questionText: 'What is the main thing you want to accomplish?',
      answer: 'custom',
      customText: 'ship a clarify plugin',
    }])
    expect(JSON.stringify(inputs[1]?.acceptedDecisions)).not.toMatch(/optionId|questionId/)
  })
})

describe('Clarify A2 CAS and non-mutating preview errors', () => {
  it('requires the live questionId+previewVersion and leaves state unchanged on mismatch', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const liveQuestion = structuredClone(started.question)
    const liveVersion = started.previewVersion

    await expect(service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: 'stale-preview',
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })).rejects.toMatchObject({ code: 'PREVIEW_OUTDATED' })

    await expect(service.answer({
      processId: started.processId,
      questionId: 'not-current',
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })

    const echoed = await service.fetchDraft({ processId: started.processId })
    expect(echoed.status).toBe('running')
    const retry = await service.answer({
      processId: started.processId,
      questionId: liveQuestion!.questionId,
      previewVersion: liveVersion!,
      selectedOptionIds: [optionId(liveQuestion!, 'Fix a bug')],
    })
    expect(retry.status).toBe('running')
    expect(retry.question?.text).toContain('constraints')
  })

  it('fetches the complete last-published running state for recovery', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const fetched = await service.fetchDraft({ processId: started.processId })

    expect(fetched).toEqual(started)
    expect(fetched.kind).toBe('ask')
    expect(fetched.question).toEqual(started.question)
    expect(fetched.draftPreview).toBe(started.draftPreview)
    expect(fetched.materialChanges).toEqual(started.materialChanges)
    expect(fetched).not.toHaveProperty('draft')
  })

  it('does not treat a live preview mismatch as process stale', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.accept({
      processId: started.processId,
      previewVersion: 'other-version',
    })).rejects.toMatchObject({ code: 'PREVIEW_OUTDATED' })
    expect(service.runningProcessIds()).toEqual([started.processId])
    const still = await service.fetchDraft({ processId: started.processId })
    expect(still.status).toBe('running')
    expect(still.staleReason).toBeUndefined()
    expect(still.draft).toBeUndefined()
  })

  it.each([
    ['contextVersion', 'ctx-v2', 'context-changed'],
    ['modelRouteId', 'route-v2', 'route-changed'],
  ] as const)('makes binding invalidation win over accept for %s', async (field, value, reason) => {
    const { service, bindings } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ [field]: value }))

    const accepted = await service.accept({
      processId: started.processId,
      previewVersion: started.previewVersion!,
    })

    expect(accepted.status).toBe('stale')
    expect(accepted.staleReason).toBe(reason)
    expect(accepted.draftPreview).toBeUndefined()
    expect(accepted.draft).toBeUndefined()
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.status).toBe('stale')
    expect(fetched.draft).toBeUndefined()
  })

  it('keeps the old preview/version when the next result is invalid or non-material', async () => {
    let calls = 0
    const inference: InferenceEngine = {
      async infer(input) {
        calls += 1
        if (input.acceptedDecisions.length === 0) return ask({ draftPreview: 'Keep this preview body intact.' })
        if (calls === 2) {
          return ask({
            question: 'Ignore me',
            options: ['dup', 'dup'],
            draftPreview: 'Keep this preview body intact.',
            materialChanges: ['claimed change'],
          })
        }
        if (calls === 3) {
          return awaitAccept({
            draftPreview: 'Intact body preview this keep.',
            materialChanges: ['word order only'],
          })
        }
        return awaitAccept({
          draftPreview: 'Materially different user draft after the failed attempts.',
          materialChanges: ['rewrote the draft'],
        })
      },
    }
    const { service } = createService({ inference })
    const started = await service.start({ sessionId: 'session-1' })
    const version = started.previewVersion
    const questionId = started.question!.questionId

    await expect(service.answer({
      processId: started.processId,
      questionId,
      previewVersion: version!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect(service.runningProcessIds()).toEqual([started.processId])

    await expect(service.answer({
      processId: started.processId,
      questionId,
      previewVersion: version!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })

    const acceptedLater = await service.answer({
      processId: started.processId,
      questionId,
      previewVersion: version!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })
    expect(acceptedLater.previewVersion).not.toBe(version)
    expect(acceptedLater.draftPreview).toBe('Materially different user draft after the failed attempts.')
  })
})

describe('Clarify A2 accept, idempotency, races, and tombstone TTL', () => {
  it('accepts the exact live version as complete with a byte-identical draft and no draft leak on accept', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const ready = await reachAwaitAccept(service, started)
    const completed = await service.accept({
      processId: ready.processId,
      previewVersion: ready.previewVersion!,
    })
    expect(completed.status).toBe('complete')
    expect(completed).not.toHaveProperty('draft')
    expect(completed).not.toHaveProperty('draftPreview')
    expect(completed.previewVersion).toBe(ready.previewVersion)
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBe(ready.draftPreview)
    expect(fetched.draft).toBe('Final user draft for a clarify Host plugin.')
  })

  it('replays the same accept and fetchDraft until TTL, then PROCESS_NOT_FOUND', async () => {
    const { service, clock } = createService({ ttlMs: 1000 })
    const started = await service.start({ sessionId: 'session-1' })
    const ready = await reachAwaitAccept(service, started)
    const first = await service.accept({
      processId: ready.processId,
      previewVersion: ready.previewVersion!,
    })
    const replay = await service.accept({
      processId: ready.processId,
      previewVersion: ready.previewVersion!,
    })
    expect(first.status).toBe('complete')
    expect(replay.status).toBe('complete')
    expect(replay).not.toHaveProperty('draft')
    const a = await service.fetchDraft({ processId: started.processId })
    const b = await service.fetchDraft({ processId: started.processId })
    expect(a.draft).toBe(b.draft)
    expect(a.draft).toBe(ready.draftPreview)
    clock.current += 1001
    await expect(service.fetchDraft({ processId: started.processId })).rejects.toMatchObject({
      code: 'PROCESS_NOT_FOUND',
    })
    await expect(service.accept({
      processId: started.processId,
      previewVersion: ready.previewVersion!,
    })).rejects.toMatchObject({ code: 'PROCESS_NOT_FOUND' })
  })

  it('returns the authoritative terminal status for cancel/accept races', async () => {
    const { service } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    const ready = await reachAwaitAccept(service, started)
    const [one, two] = await Promise.all([
      service.accept({ processId: ready.processId, previewVersion: ready.previewVersion! }),
      service.cancel({ processId: started.processId }),
    ])
    const statuses = [one.status, two.status]
    expect(new Set(statuses).size).toBe(1)
    expect(['complete', 'cancelled']).toContain(statuses[0])
    expect(one).not.toHaveProperty('draft')
    expect(two).not.toHaveProperty('draft')
    if (statuses[0] === 'complete') {
      const fetched = await service.fetchDraft({ processId: started.processId })
      expect(fetched.draft).toBe(ready.draftPreview)
    } else {
      const fetched = await service.fetchDraft({ processId: started.processId })
      expect(fetched.draft).toBeUndefined()
      expect(fetched.status).toBe('cancelled')
    }
  })

  it('rejects accept during an in-flight answer without aborting or mutating the ask', async () => {
    const pending: Array<{ resolve: (value: ModelInference) => void }> = []
    let sawAbort = false
    const inference: InferenceEngine = {
      async infer(input, signal) {
        if (input.acceptedDecisions.length === 0) return ask()
        return await new Promise((resolve, reject) => {
          pending.push({ resolve })
          signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('aborted'))
          })
        })
      },
    }
    const cancelled: string[] = []
    const { service } = createService({
      inference,
      onCancelInFlight: (processId) => cancelled.push(processId),
    })
    const started = await service.start({ sessionId: 'session-1' })
    const inFlight = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    const publishedDuringInference = await service.fetchDraft({ processId: started.processId })
    expect(publishedDuringInference).toEqual(started)
    expect(publishedDuringInference).not.toHaveProperty('draft')
    await expect(service.accept({
      processId: started.processId,
      previewVersion: started.previewVersion!,
    })).rejects.toMatchObject({ code: 'PROCESS_BUSY' })
    expect(sawAbort).toBe(false)
    expect(cancelled).toEqual([])
    pending[0]!.resolve(awaitAccept())
    const ready = await inFlight
    expect(ready).toMatchObject({ status: 'running', kind: 'await_accept' })
    const publishedReady = await service.fetchDraft({ processId: started.processId })
    expect(publishedReady).toEqual(ready)
    expect(publishedReady).not.toHaveProperty('draft')
    const completed = await service.accept({
      processId: ready.processId,
      previewVersion: ready.previewVersion!,
    })
    expect(completed.status).toBe('complete')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBe(ready.draftPreview)
  })

  it('keeps stale as binding invalidation only and never leaks draft on answer/cancel terminals', async () => {
    const { service, bindings } = createService()
    const started = await service.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    const answered = await service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })
    expect(answered.status).toBe('stale')
    expect(answered.staleReason).toBe('context-changed')
    expect(answered).not.toHaveProperty('draft')
    expect(answered.question).toBeUndefined()
    const cancelled = await service.cancel({ processId: started.processId })
    expect(cancelled.status).toBe('stale')
    expect(cancelled).not.toHaveProperty('draft')
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBeUndefined()
  })
})

describe('Clarify A2 production default is not a silent semantic stub', () => {
  it('boots the plugin without an authorized engine', () => {
    expect(() => apply({ inject() {} })).not.toThrow()
  })

  it('fails start truthfully when no engine is injected and does not leave a running process', async () => {
    const service = new ClarifyService({
      resolveBinding: () => binding(),
    })
    await expect(service.start({ sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'INFERENCE_UNAVAILABLE',
    })
    expect(service.runningProcessIds()).toEqual([])
  })
})

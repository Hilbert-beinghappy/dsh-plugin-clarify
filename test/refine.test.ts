import { describe, expect, it } from 'vitest'
import { ClarifyService } from '../src/clarify-service.ts'
import { ClarifyError, type AcceptedDecision, type HostBinding, type InferenceEngine, type InferenceInput, type ModelInference } from '../src/types.ts'

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

function createService(inference: InferenceEngine, bindings = new Map([['session-1', binding()]])) {
  return new ClarifyService({
    resolveBinding: (sessionId) => {
      const found = bindings.get(sessionId)
      if (!found) throw new ClarifyError('PROCESS_NOT_FOUND', `unknown session ${sessionId}`, 'protocol')
      return found
    },
    inference,
  })
}

function optionId(question: { options: Array<{ optionId: string; text: string }> }, text: string): string {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

describe('accept on ask', () => {
  it('accepts a matching ask preview, discards the live question, and does not invent a decision', async () => {
    const seen: InferenceInput[] = []
    const service = createService({
      async infer(input) {
        seen.push(structuredClone(input))
        return ask()
      },
    })
    const started = await service.start({ sessionId: 'session-1', seedText: 'half-written ask' })
    expect(started.kind).toBe('ask')
    const completed = await service.accept({
      processId: started.processId,
      previewVersion: started.previewVersion!,
    })
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
    const fetched = await service.fetchDraft({ processId: started.processId })
    expect(fetched.draft).toBe(started.draftPreview)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.acceptedDecisions).toEqual([])
  })
})

describe('refine Remote', () => {
  it('refines from ask and await_accept on the same process while preserving acceptedDecisions', async () => {
    const seen: InferenceInput[] = []
    const service = createService({
      async infer(input) {
        seen.push(structuredClone(input))
        if (input.refineFeedback) {
          return awaitAccept({
            draftPreview: `Refined from ${input.priorPublishedDraft?.draftPreview ?? ''} with ${input.refineFeedback}`,
            materialChanges: ['applied refinement'],
          })
        }
        if (input.acceptedDecisions.length === 0) return ask()
        return awaitAccept({
          draftPreview: 'User draft after choosing a feature.',
          materialChanges: ['recorded the goal'],
        })
      },
    })
    const started = await service.start({ sessionId: 'session-1', seedText: 'need a plugin' })
    const fromAsk = await service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'focus on Host Remote only',
    })
    expect(fromAsk.status).toBe('running')
    expect(fromAsk.processId).toBe(started.processId)
    expect(fromAsk.previewVersion).not.toBe(started.previewVersion)
    expect(fromAsk.draftPreview).toContain('focus on Host Remote only')
    expect(seen[1]?.acceptedDecisions).toEqual([])
    expect(seen[1]?.refineFeedback).toBe('focus on Host Remote only')
    expect(seen[1]?.priorPublishedDraft).toEqual({
      draftPreview: started.draftPreview,
      materialChanges: started.materialChanges,
    })
    expect(seen[1]?.seedText).toBe('need a plugin')

    const askedAgain = await service.start({ sessionId: 'session-1', seedText: 'second process' })
    const answered = await service.answer({
      processId: askedAgain.processId,
      questionId: askedAgain.question!.questionId,
      previewVersion: askedAgain.previewVersion!,
      selectedOptionIds: [optionId(askedAgain.question!, 'Add a feature')],
    })
    expect(answered.kind).toBe('await_accept')
    const decisionsBefore = seen.at(-1)?.acceptedDecisions
    const fromReady = await service.refine({
      processId: askedAgain.processId,
      previewVersion: answered.previewVersion!,
      feedback: 'add rollback',
    })
    expect(fromReady.status).toBe('running')
    expect(fromReady.processId).toBe(askedAgain.processId)
    expect(seen.at(-1)?.acceptedDecisions).toEqual(decisionsBefore)
    expect(seen.at(-1)?.refineFeedback).toBe('add rollback')
    expect(seen.at(-1)?.priorPublishedDraft?.draftPreview).toBe(answered.draftPreview)
  })

  it('keeps the old preview, version, and question when refine inference fails', async () => {
    let fail = false
    const service = createService({
      async infer(input) {
        if (input.refineFeedback) {
          if (fail) throw new Error('simulated 502')
          return '{not-json'
        }
        return ask({ draftPreview: 'Keep this preview body intact.' })
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'broken parse',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    const afterParse = await service.fetchDraft({ processId: started.processId })
    expect(afterParse).toEqual(started)

    fail = true
    await expect(service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'broken transport',
    })).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE' })
    const afterUnknown = await service.fetchDraft({ processId: started.processId })
    expect(afterUnknown).toEqual(started)
    expect(afterUnknown.question).toEqual(started.question)
    expect(afterUnknown.previewVersion).toBe(started.previewVersion)
  })

  it('rejects non-material refine without mutating published state', async () => {
    const service = createService({
      async infer(input) {
        if (input.refineFeedback) {
          return ask({
            question: 'A different question that is not a material preview change.',
            draftPreview: 'Keep this preview body intact.',
            materialChanges: ['punctuation only'],
          })
        }
        return ask({ draftPreview: 'Keep this preview body intact.' })
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'rephrase only',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    expect(await service.fetchDraft({ processId: started.processId })).toEqual(started)
  })

  it('uses PROCESS_BUSY, cancel, and stale semantics that match answer', async () => {
    const pending: Array<{ resolve: (value: ModelInference) => void }> = []
    const service = createService({
      async infer(input, signal) {
        if (input.acceptedDecisions.length === 0 && !input.refineFeedback) return ask()
        return await new Promise((resolve, reject) => {
          pending.push({ resolve })
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    const answering = service.answer({
      processId: started.processId,
      questionId: started.question!.questionId,
      previewVersion: started.previewVersion!,
      selectedOptionIds: [optionId(started.question!, 'Add a feature')],
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'wait',
    })).rejects.toMatchObject({ code: 'PROCESS_BUSY' })
    pending[0]!.resolve(awaitAccept())
    await answering

    const cancelledService = createService({
      async infer() { return ask() },
    })
    const live = await cancelledService.start({ sessionId: 'session-1' })
    await cancelledService.cancel({ processId: live.processId })
    const cancelled = await cancelledService.refine({
      processId: live.processId,
      previewVersion: live.previewVersion!,
      feedback: 'too late',
    })
    expect(cancelled.status).toBe('cancelled')

    const bindings = new Map([['session-1', binding()]])
    const staleService = createService({
      async infer() { return ask() },
    }, bindings)
    const staleLive = await staleService.start({ sessionId: 'session-1' })
    bindings.set('session-1', binding({ contextVersion: 'ctx-v2' }))
    const stale = await staleService.refine({
      processId: staleLive.processId,
      previewVersion: staleLive.previewVersion!,
      feedback: 'too late',
    })
    expect(stale.status).toBe('stale')
    expect(stale.staleReason).toBe('context-changed')
  })

  it('maps unknown start exceptions to INFERENCE_UNAVAILABLE and discards the unpublished process', async () => {
    const service = createService({
      async infer() {
        throw new Error('simulated 502')
      },
    })
    await expect(service.start({ sessionId: 'session-1' })).rejects.toMatchObject({
      code: 'INFERENCE_UNAVAILABLE',
    })
    expect(service.runningProcessIds()).toEqual([])
  })

  it('rejects empty refine feedback and a mismatched previewVersion without inferring', async () => {
    let calls = 0
    const service = createService({
      async infer() {
        calls += 1
        return ask()
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    await expect(service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: '   ',
    })).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    await expect(service.refine({
      processId: started.processId,
      previewVersion: 'other-version',
      feedback: 'real feedback',
    })).rejects.toMatchObject({ code: 'PREVIEW_OUTDATED' })
    expect(calls).toBe(1)
    expect(await service.fetchDraft({ processId: started.processId })).toEqual(started)
  })
})

describe('acceptedDecisions stay frozen across refine', () => {
  it('does not append a decision when refining an unanswered ask', async () => {
    const seen: AcceptedDecision[][] = []
    const service = createService({
      async infer(input) {
        seen.push(structuredClone(input.acceptedDecisions) as AcceptedDecision[])
        if (input.refineFeedback) {
          return awaitAccept({
            draftPreview: 'Materially different refined user draft.',
            materialChanges: ['applied refinement'],
          })
        }
        return ask()
      },
    })
    const started = await service.start({ sessionId: 'session-1' })
    await service.refine({
      processId: started.processId,
      previewVersion: started.previewVersion!,
      feedback: 'narrow the host surface',
    })
    expect(seen[0]).toEqual([])
    expect(seen[1]).toEqual([])
  })
})

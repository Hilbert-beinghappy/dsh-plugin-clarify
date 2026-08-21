import { describe, expect, it } from 'vitest'
import { ClarifyService } from '../src/clarify-service.ts'
import { dispatchClarifyRpc } from '../src/rpc.ts'
import { StubInferenceEngine } from './fixtures/stub-inference.mjs'
import { ClarifyError, type HostBinding } from '../src/types.ts'

function service(): ClarifyService {
  const binding: HostBinding = {
    sessionId: 'session-e2e',
    contextVersion: 'ctx-e2e',
    modelRouteId: 'route-e2e',
  }
  return new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
  })
}

function optionId(question: { options: Array<{ optionId: string; text: string }> }, text: string): string {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

describe('six Remote stub methods', () => {
  it('runs start → answer×N → accept → fetchDraft and rejects stale/cancelled answers', async () => {
    const clarify = service()
    const started = await dispatchClarifyRpc(clarify, 'start', { sessionId: 'session-e2e', seedText: 'clarify host plugin' })
    expect(started.status).toBe('running')
    expect(started.question).toBeTruthy()
    expect(started.kind).toBe('ask')
    expect(started.previewVersion).toBeTruthy()
    expect(started).not.toHaveProperty('draft')

    const q2 = await dispatchClarifyRpc(clarify, 'answer', {
      processId: started.processId,
      questionId: started.question.questionId,
      previewVersion: started.previewVersion,
      selectedOptionIds: [optionId(started.question, 'Add a feature')],
    })
    expect(q2.status).toBe('running')
    expect(q2.question.multiple).toBe(true)

    const ready = await dispatchClarifyRpc(clarify, 'answer', {
      processId: started.processId,
      questionId: q2.question.questionId,
      previewVersion: q2.previewVersion,
      selectedOptionIds: [optionId(q2.question, 'Compatibility')],
    })
    expect(ready.status).toBe('running')
    expect(ready.kind).toBe('await_accept')
    expect(ready.materialChanges).toEqual(['assembled the user draft'])
    expect(ready.question).toBeUndefined()
    expect(ready.draft).toBeUndefined()

    const refined = await dispatchClarifyRpc(clarify, 'refine', {
      processId: started.processId,
      previewVersion: ready.previewVersion,
      feedback: 'add rollback',
    })
    expect(refined.status).toBe('running')
    expect(refined.processId).toBe(started.processId)
    expect(refined.previewVersion).not.toBe(ready.previewVersion)
    expect(refined.draftPreview).toContain('add rollback')

    const completed = await dispatchClarifyRpc(clarify, 'accept', {
      processId: started.processId,
      previewVersion: refined.previewVersion,
    })
    expect(completed.status).toBe('complete')
    expect(completed.draft).toBeUndefined()

    const fetched = await dispatchClarifyRpc(clarify, 'fetchDraft', { processId: started.processId })
    expect(fetched.status).toBe('complete')
    expect(fetched.draft).toContain('clarify host plugin')

    const other = service()
    const running = await dispatchClarifyRpc(other, 'start', { sessionId: 'session-e2e' })
    await dispatchClarifyRpc(other, 'cancel', { processId: running.processId })
    const cancelledAnswer = await dispatchClarifyRpc(other, 'answer', {
      processId: running.processId,
      questionId: running.question.questionId,
      previewVersion: running.previewVersion,
      selectedOptionIds: [optionId(running.question, 'Add a feature')],
    })
    expect(cancelledAnswer.status).toBe('cancelled')

    const staleTarget = service()
    const live = await dispatchClarifyRpc(staleTarget, 'start', { sessionId: 'session-e2e' })
    staleTarget.markStale(live.processId, 'recall-injection')
    const staleAnswer = await dispatchClarifyRpc(staleTarget, 'answer', {
      processId: live.processId,
      questionId: live.question.questionId,
      previewVersion: live.previewVersion,
      selectedOptionIds: [optionId(live.question, 'Add a feature')],
    })
    expect(staleAnswer.status).toBe('stale')
    expect(staleAnswer.staleReason).toBe('recall-injection')
    expect(staleAnswer.question).toBeUndefined()
  })

  it('rejects unknown methods with INVALID_ANSWER-equivalent RPC error', async () => {
    const clarify = service()
    await expect(dispatchClarifyRpc(clarify, 'prompt', { sessionId: 'session-e2e' })).rejects.toBeInstanceOf(ClarifyError)
  })
})

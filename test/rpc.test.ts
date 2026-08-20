import { describe, expect, it } from 'vitest'
import { ClarifyService } from '../src/clarify-service.ts'
import { dispatchClarifyRpc } from '../src/rpc.ts'
import { ClarifyError, type HostBinding } from '../src/types.ts'

function service(): ClarifyService {
  const binding: HostBinding = {
    sessionId: 'session-e2e',
    contextVersion: 'ctx-e2e',
    modelRouteId: 'route-e2e',
  }
  return new ClarifyService({
    resolveBinding: () => binding,
  })
}

describe('four Remote stub methods', () => {
  it('runs start → answer×N → fetchDraft and rejects stale/cancelled answers', async () => {
    const clarify = service()
    const started = await dispatchClarifyRpc(clarify, 'start', { sessionId: 'session-e2e', seedText: 'clarify host plugin' })
    expect(started.status).toBe('running')
    expect(started.question).toBeTruthy()
    expect(started).not.toHaveProperty('draft')

    const q2 = await dispatchClarifyRpc(clarify, 'answer', {
      processId: started.processId,
      questionId: started.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    expect(q2.status).toBe('running')
    expect(q2.question.multiple).toBe(true)

    const completed = await dispatchClarifyRpc(clarify, 'answer', {
      processId: started.processId,
      questionId: q2.question.questionId,
      selectedOptionIds: ['o-compat'],
    })
    expect(completed.status).toBe('complete')
    expect(completed.question).toBeUndefined()
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
      selectedOptionIds: ['o-feature'],
    })
    expect(cancelledAnswer.status).toBe('cancelled')

    const staleTarget = service()
    const live = await dispatchClarifyRpc(staleTarget, 'start', { sessionId: 'session-e2e' })
    staleTarget.markStale(live.processId, 'recall-injection')
    const staleAnswer = await dispatchClarifyRpc(staleTarget, 'answer', {
      processId: live.processId,
      questionId: live.question.questionId,
      selectedOptionIds: ['o-feature'],
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

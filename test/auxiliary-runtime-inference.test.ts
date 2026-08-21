import { describe, expect, it } from 'vitest'
import {
  AuxiliaryRuntimeInferenceEngine,
  type AuxiliaryRuntimeLike,
} from '../src/auxiliary-runtime-inference.ts'
import { captureInferenceSnapshot } from '../src/inference-snapshot.ts'
import type { InferenceInput } from '../src/types.ts'

const validJson = JSON.stringify({
  kind: 'await_accept',
  draftPreview: 'A Session-grounded draft produced through the auxiliary runtime.',
  materialChanges: ['used the current Session context'],
})

function input(maxTokens: number | null = 512): InferenceInput {
  return {
    sessionId: 'live-session',
    seedText: 'Clarify this implementation request.',
    acceptedDecisions: [],
    snapshot: captureInferenceSnapshot('live-session', {
      requestHeader: () => ({
        config: {
          provider: 'official',
          model: 'active',
          ...maxTokens === null ? {} : { maxTokens },
        },
        tools: [{ name: 'must-not-be-forwarded' }],
      }),
      requestContext: () => ({ provider: 'official', model: 'active', contextWindow: 64_000 }),
      deriveMessages: () => [{
        id: 'history-1',
        role: 'user',
        content: [{ type: 'text', text: 'Implement the active feature.' }],
        source: { kind: 'user' },
      }],
    }),
  }
}

type RunRequest = Parameters<AuxiliaryRuntimeLike['run']>[0]

describe('production auxiliary-runtime inference adapter', () => {
  it('builds only after materialized config and leaves dispatch/accounting with the runtime', async () => {
    let seen: RunRequest | undefined
    let built: ReturnType<RunRequest['prepareRequest']> | undefined
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        seen = request
        built = request.prepareRequest({
          config: { ...request.config, maxTokens: 777 },
          context: { contextWindow: 64_000 },
          adapterDefaults: { maxTokens: true },
        })
        return { status: 'succeeded', output: validJson }
      },
    }
    const engine = new AuxiliaryRuntimeInferenceEngine({ runtime, idFactory: () => 'call-fixed' })
    await expect(engine.infer(input(), new AbortController().signal)).resolves.toBe(validJson)

    expect(seen).toMatchObject({
      callId: 'clarify-call-fixed',
      sessionId: 'live-session',
      purpose: 'clarify',
      config: { provider: 'official', model: 'active', maxTokens: 512 },
    })
    expect(built?.reservation.outputTokens).toBe(777)
    expect(built!.reservation.uncachedInputTokens).toBeGreaterThan(0)
    expect(built?.system).toContain('Clarify drafting engine')
    expect(JSON.stringify(built)).not.toContain('must-not-be-forwarded')
    const prompt = (built?.messages[0] as { content: Array<{ text: string }> }).content[0]!.text
    expect(prompt).toContain('Implement the active feature.')
    expect(seen).not.toHaveProperty('messages')
    expect(seen).not.toHaveProperty('system')
  })

  it('uses the exact prepared context and materialized maxTokens', async () => {
    let seen: RunRequest | undefined
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        seen = request
        const built = request.prepareRequest({
          config: { ...request.config, maxTokens: 900 },
          context: { contextWindow: 128_000 },
          adapterDefaults: { maxTokens: true },
        })
        expect(built.reservation.outputTokens).toBe(900)
        return { status: 'succeeded', output: validJson }
      },
    }
    const engine = new AuxiliaryRuntimeInferenceEngine({ runtime })
    await engine.infer(input(null), new AbortController().signal)
    expect(seen).not.toHaveProperty('reservation')
  })

  it('fails closed when prepareCall remaps the captured Session model route', async () => {
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        request.prepareRequest({
          config: { ...request.config, provider: 'remapped-provider', model: 'remapped-model', maxTokens: 900 },
          context: { contextWindow: 64_000 },
          adapterDefaults: { maxTokens: true },
        })
        throw new Error('unreachable')
      },
    }
    const engine = new AuxiliaryRuntimeInferenceEngine({ runtime })
    await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({
      code: 'INFERENCE_UNAVAILABLE',
      category: 'conflict',
    })
  })

  it('fails closed when the prepared handle omits context metadata', async () => {
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        request.prepareRequest({
          config: { ...request.config, maxTokens: 900 },
          adapterDefaults: { maxTokens: true },
        })
        throw new Error('unreachable')
      },
    }
    const engine = new AuxiliaryRuntimeInferenceEngine({ runtime })
    await expect(engine.infer(input(null), new AbortController().signal)).rejects.toMatchObject({
      code: 'INFERENCE_UNAVAILABLE',
      category: 'configuration',
    })
  })

  it('maps durable auxiliary failure facts without exposing provider messages', async () => {
    for (const testCase of [
      { failure: { category: 'quota' as const, code: 'QUOTA' }, category: 'retryable' },
      { failure: { category: 'limit' as const, code: 'MAX_CALLS_PER_SESSION' }, category: 'configuration' },
      { failure: { category: 'conflict' as const, code: 'CALL_ID_ACTIVE' }, category: 'conflict' },
    ]) {
      const runtime: AuxiliaryRuntimeLike = {
        async run() {
          return { status: 'failed', output: null, failure: testCase.failure }
        },
      }
      const engine = new AuxiliaryRuntimeInferenceEngine({ runtime })
      await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({
        code: 'INFERENCE_UNAVAILABLE',
        category: testCase.category,
      })
    }
  })

  it('rejects an invalid repair route before allocating an auxiliary call', async () => {
    let calls = 0
    const runtime: AuxiliaryRuntimeLike = {
      async run() {
        calls += 1
        return { status: 'succeeded', output: validJson }
      },
    }
    const engine = new AuxiliaryRuntimeInferenceEngine({ runtime })
    await expect(engine.repair!({
      ...input(),
      routeId: 'wrong-route',
      raw: '{',
      reason: 'invalid JSON',
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE', category: 'conflict' })
    expect(calls).toBe(0)
  })
})

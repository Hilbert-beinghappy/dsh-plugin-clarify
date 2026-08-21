import { describe, expect, it } from 'vitest'
import { captureInferenceSnapshot } from '../src/inference-snapshot.ts'
import { callConfigEquals, MAX_MODEL_OUTPUT_CHARS, PreparedCallInferenceEngine, type PreparedCallLlmLike, type PreparedGenerateOptions, type PreparedStreamChunk } from '../src/prepared-call-inference.ts'
import type { InferenceInput } from '../src/types.ts'

function input(): InferenceInput {
  return {
    sessionId: 'existing-session',
    seedText: 'Build context-specific options.',
    acceptedDecisions: [{
      questionText: 'Which compatibility boundary should the draft preserve?',
      answer: 'selected_options',
      selectedOptionTexts: ['Preserve official Host compatibility'],
    }],
    priorPublishedDraft: {
      draftPreview: 'Prior published draft before this answer.',
      materialChanges: ['opened compatibility'],
    },
    snapshot: captureInferenceSnapshot('existing-session', {
      requestHeader: () => ({
        config: { provider: 'official', model: 'active', reasoningEffort: 'high', temperature: 0.3 },
        system: 'untrusted session system',
        tools: [{ name: 'must-not-be-sent' }],
      }),
      requestContext: () => ({ provider: 'official', model: 'active', contextWindow: 64_000 }),
      deriveMessages: () => [{ id: 'history-1', role: 'user', content: [{ type: 'text', text: 'real context' }], source: { kind: 'user' } }],
    }),
  }
}

function llmWithStreams(streams: PreparedStreamChunk[][], seen: { configs: unknown[]; options: PreparedGenerateOptions[] }): PreparedCallLlmLike {
  return {
    async prepareCall(config) {
      seen.configs.push(config)
      const chunks = streams.shift()
      if (!chunks) throw new Error('unscripted prepareCall')
      return {
        config: { ...config, maxTokens: config.maxTokens ?? 777 },
        async *stream(options) {
          if (!callConfigEquals(options, { ...config, maxTokens: config.maxTokens ?? 777 })) {
            throw new Error('INVALID_PREPARED_CALL')
          }
          seen.options.push(options)
          yield* chunks
        },
      }
    },
  }
}

const validJson = JSON.stringify({
  kind: 'await_accept',
  draftPreview: 'A dynamic draft grounded in the real Session context.',
  materialChanges: ['used the active context'],
})

describe('official prepared-call compatibility adapter (mock only)', () => {
  it('uses the prepared config exactly, existing Session ID, no tools/purpose, and only visible text', async () => {
    const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
    const engine = new PreparedCallInferenceEngine({
      llm: llmWithStreams([[
        { type: 'block-start', blockType: 'text' },
        { type: 'reasoning-delta', text: 'private reasoning' },
        { type: 'text-delta', text: validJson.slice(0, 20) },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
        { type: 'text-delta', text: validJson.slice(20) },
        { type: 'finish', reason: { kind: 'stop' } },
      ]], seen),
      isDispatchAuthorized: () => true,
    })
    const result = await engine.infer(input(), new AbortController().signal)
    expect(result).toBe(validJson)
    expect(seen.configs).toHaveLength(1)
    expect(seen.options).toHaveLength(1)
    expect(seen.options[0]).toMatchObject({ provider: 'official', model: 'active', maxTokens: 777, sessionId: 'existing-session' })
    expect(seen.options[0]).not.toHaveProperty('tools')
    expect(seen.options[0]).not.toHaveProperty('purpose')
    expect(seen.options[0]).not.toHaveProperty('markAgentLoopRequest')
    expect(seen.options[0]!.messages[0].content[0].text).not.toContain('must-not-be-sent')
    expect(JSON.stringify(seen.options[0])).not.toContain('private reasoning')
  })

  it('defaults to unauthorized and never reaches prepareCall', async () => {
    let prepares = 0
    const engine = new PreparedCallInferenceEngine({
      llm: {
        async prepareCall() {
          prepares += 1
          throw new Error('must not run')
        },
      },
    })
    await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE' })
    expect(prepares).toBe(0)
  })

  it('rejects a missing advertised context window before prepareCall', async () => {
    let prepares = 0
    const engine = new PreparedCallInferenceEngine({
      llm: {
        async prepareCall() {
          prepares += 1
          throw new Error('must not run')
        },
      },
      isDispatchAuthorized: () => true,
    })
    const withoutWindow: InferenceInput = {
      ...input(),
      snapshot: captureInferenceSnapshot('existing-session', {
        requestHeader: () => ({ config: { provider: 'official', model: 'active', maxTokens: 777 } }),
        requestContext: () => ({ provider: 'official', model: 'active' }),
        deriveMessages: () => [],
      }),
    }
    await expect(engine.infer(withoutWindow, new AbortController().signal)).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE' })
    expect(prepares).toBe(0)
  })

  it('uses a fresh prepared handle for repair and keeps repair data inside untrusted DATA', async () => {
    const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
    const engine = new PreparedCallInferenceEngine({
      llm: llmWithStreams([
        [{ type: 'text-delta', text: '{' }, { type: 'finish', reason: { kind: 'stop' } }],
        [{ type: 'text-delta', text: validJson }, { type: 'finish', reason: { kind: 'stop' } }],
      ], seen),
      isDispatchAuthorized: () => true,
    })
    const first = await engine.infer(input(), new AbortController().signal)
    const repaired = await engine.repair!({ ...input(), routeId: input().snapshot!.modelRouteId, raw: first, reason: 'invalid JSON' }, new AbortController().signal)
    expect(repaired).toBe(validJson)
    expect(seen.configs).toHaveLength(2)
    expect(seen.options[1]!.messages[0].content[0].text).toContain('repairAttempt')
    expect(seen.options[1]!.messages[0].content[0].text).toContain('invalid JSON')
  })

  it('uses only prepared config fields when adapter resolution omits proposed sampling values', async () => {
    const seen: PreparedGenerateOptions[] = []
    const engine = new PreparedCallInferenceEngine({
      llm: {
        async prepareCall() {
          const config = { provider: 'official', model: 'active', maxTokens: 777 }
          return {
            config,
            async *stream(options) {
              seen.push(options)
              if (!callConfigEquals(options, config)) throw new Error('INVALID_PREPARED_CALL')
              yield { type: 'text-delta', text: validJson } as const
              yield { type: 'finish', reason: { kind: 'stop' } } as const
            },
          }
        },
      },
      isDispatchAuthorized: () => true,
    })
    await engine.infer(input(), new AbortController().signal)
    expect(seen[0]).not.toHaveProperty('temperature')
    expect(seen[0]).not.toHaveProperty('reasoningEffort')
    expect(seen[0]).not.toHaveProperty('stop')
  })

  it('rejects prepared provider or model drift before opening a stream', async () => {
    for (const config of [
      { provider: 'different-provider', model: 'active', maxTokens: 777 },
      { provider: 'official', model: 'different-model', maxTokens: 777 },
    ]) {
      let streams = 0
      const engine = new PreparedCallInferenceEngine({
        llm: {
          async prepareCall() {
            return {
              config,
              async *stream() {
                streams += 1
                yield { type: 'text-delta', text: validJson } as const
              },
            }
          },
        },
        isDispatchAuthorized: () => true,
      })
      await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE' })
      expect(streams).toBe(0)
    }
  })

  it.each([
    [{ type: 'tool-call-delta' }, 'INVALID_ANSWER'],
    [{ type: 'finish', reason: { kind: 'tool-calls' } }, 'INVALID_ANSWER'],
    [{ type: 'finish', reason: { kind: 'max-tokens' } }, 'INVALID_ANSWER'],
    [{ type: 'finish', reason: { kind: 'error' } }, 'INFERENCE_UNAVAILABLE'],
    [{ type: 'finish', reason: { kind: 'aborted' } }, 'INFERENCE_UNAVAILABLE'],
  ] as Array<[PreparedStreamChunk, string]>)('fails closed for unsafe stream chunk %#', async (chunk, code) => {
    const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
    const engine = new PreparedCallInferenceEngine({
      llm: llmWithStreams([[chunk]], seen),
      isDispatchAuthorized: () => true,
    })
    await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({ code })
  })

  it('consumes usage ephemerally without claiming that this proves Session accounting', async () => {
    const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
    const engine = new PreparedCallInferenceEngine({
      llm: llmWithStreams([[
        { type: 'text-delta', text: validJson },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]], seen),
      isDispatchAuthorized: () => true,
    })
    await expect(engine.infer(input(), new AbortController().signal)).resolves.toBe(validJson)
    expect(seen.options).toHaveLength(1)
  })

  it('rejects duplicate/post-finish chunks and oversized visible output', async () => {
    for (const chunks of [
      [{ type: 'text-delta', text: validJson }, { type: 'finish', reason: { kind: 'stop' } }, { type: 'text-delta', text: 'late' }],
      [{ type: 'text-delta', text: 'x'.repeat(MAX_MODEL_OUTPUT_CHARS + 1) }, { type: 'finish', reason: { kind: 'stop' } }],
    ] as PreparedStreamChunk[][]) {
      const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
      const engine = new PreparedCallInferenceEngine({
        llm: llmWithStreams([chunks], seen),
        isDispatchAuthorized: () => true,
      })
      await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    }
  })

  it('fails closed on missing finish, empty visible text, and mid-stream abort', async () => {
    const cases: Array<{ chunks: PreparedStreamChunk[]; abortAfterFirst?: boolean; code: string }> = [
      { chunks: [{ type: 'text-delta', text: validJson }], code: 'INFERENCE_UNAVAILABLE' },
      { chunks: [{ type: 'usage', usage: {} }, { type: 'finish', reason: { kind: 'stop' } }], code: 'INVALID_ANSWER' },
    ]
    for (const testCase of cases) {
      const seen = { configs: [] as unknown[], options: [] as PreparedGenerateOptions[] }
      const engine = new PreparedCallInferenceEngine({ llm: llmWithStreams([[...testCase.chunks]], seen), isDispatchAuthorized: () => true })
      await expect(engine.infer(input(), new AbortController().signal)).rejects.toMatchObject({ code: testCase.code })
    }
    const controller = new AbortController()
    const engine = new PreparedCallInferenceEngine({
      llm: {
        async prepareCall(config) {
          return {
            config: { ...config, maxTokens: 777 },
            async *stream() {
              yield { type: 'text-delta', text: '{' } as const
              controller.abort()
              yield { type: 'text-delta', text: 'late' } as const
            },
          }
        },
      },
      isDispatchAuthorized: () => true,
    })
    await expect(engine.infer(input(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects repair when its route ID differs from the captured snapshot', async () => {
    let prepares = 0
    const engine = new PreparedCallInferenceEngine({
      llm: {
        async prepareCall() {
          prepares += 1
          throw new Error('must not run')
        },
      },
      isDispatchAuthorized: () => true,
    })
    await expect(engine.repair!({ ...input(), routeId: 'wrong-route', raw: '{', reason: 'invalid' }, new AbortController().signal)).rejects.toMatchObject({ code: 'INFERENCE_UNAVAILABLE' })
    expect(prepares).toBe(0)
  })
})

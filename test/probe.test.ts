import { describe, expect, it } from 'vitest'
import { collectProbeEvidence, peekService } from '../src/probe.ts'

describe('T0 probe safety', () => {
  it('does not throw when undeclared Cordis services throw on access', async () => {
    const ctx = new Proxy({
      webServer: { register() {} },
    }, {
      get(target, prop, receiver) {
        if (prop === 'remote' || prop === 'credentials' || prop === 'connection') {
          throw new Error(`waiting for service: ${String(prop)}`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const evidence = await collectProbeEvidence(ctx)
    expect(evidence.capturedAt).toBeTruthy()
    expect(evidence.usage).toBeTruthy()
    expect(evidence.header).toBeTruthy()
    expect(evidence.web).toBeTruthy()
    expect((evidence.web as { hasRemoteMount?: boolean }).hasRemoteMount).toBe(false)
  })

  it('peekService records the throw instead of propagating it', () => {
    const ctx = new Proxy({}, {
      get() {
        throw new Error('waiting for service: remote')
      },
    })
    expect(peekService(ctx, 'remote')).toEqual({
      present: false,
      error: 'waiting for service: remote',
    })
  })

  it('records that a direct usage chunk leaves official Session usage projections unchanged', async () => {
    const session = {
      id: 'existing-session',
      events: [],
      deriveMessages: () => [],
      requestHeader: () => undefined,
      surface: { nodes: [] },
    }
    const ctx = {
      llm: {
        registerAdapter() {},
        async * stream() {
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
      sessions: {
        list: () => [session],
        get: () => session,
        create: () => session,
      },
      tokenMeter: {
        measure: () => ({ logRevision: 0, totalTokens: 0 }),
      },
      sessionProjections: {
        snapshot: () => ({
          values: {
            tokenUsage: {
              uncachedInputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        }),
      },
    }

    const evidence = await collectProbeEvidence(ctx)
    const usage = evidence.usage as Record<string, unknown>
    expect(usage.sessionSource).toBe('existing')
    expect(usage.chunkTypes).toEqual(['usage', 'finish'])
    expect(usage.usageProjectionBefore).toEqual(usage.usageProjectionAfter)
    expect(usage.usageProjectionAfter).toEqual({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(usage.expectedUsageProjectionDelta).toEqual({
      uncachedInputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(usage.limits).toMatchObject({ status: 'unproven' })
    expect(usage.cancellation).toMatchObject({ status: 'unproven' })
  })

  it('recognizes business arrivals inside clarify.wire/1 envelopes for all six methods', async () => {
    const methods = ['start', 'answer', 'accept', 'refine', 'cancel', 'fetchDraft']
    const evidence = await collectProbeEvidence({
      typert: {
        local: {
          list: () => methods.map((method) => ({ namespace: 'clarify', method })),
          get: () => ({}),
        },
      },
      typertGateway: {
        invoke: async ({ method }) => ({
          protocol: 'clarify.wire/1',
          ok: false,
          error: {
            code: method === 'start' ? 'SESSION_ID_REQUIRED' : 'PROCESS_NOT_FOUND',
            message: method === 'start' ? 'sessionId is required' : 'process missing-process does not exist',
            category: 'protocol',
          },
        }),
      },
    })
    const consumer = (evidence.web as { consumerPath: Record<string, unknown> }).consumerPath
    expect(consumer.status).toBe('observed')
    expect(consumer.observed).toBe(6)
  })
})

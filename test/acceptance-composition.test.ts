import { describe, expect, it } from 'vitest'
import { composeAcceptedHostInference } from '../src/acceptance.ts'
import { CLARIFY_REMOTE_METHODS } from '../src/compat.ts'
import { apply, TYPERT_READY_INJECT, type ClarifyHostContext } from '../src/index.ts'
import type {
  ClarifyRemote,
} from '../src/remote.ts'
import type {
  PreparedCallLlmLike,
  PreparedGenerateOptions,
} from '../src/prepared-call-inference.ts'
import { unwrapClarifyWire } from '../src/types.ts'

interface Harness {
  ambientPrepareCalls(): number
  remote(): ClarifyRemote
  remount(): ClarifyRemote
}

function createHarness(): Harness {
  const services = new Map<string, unknown>()
  let ambientPrepareCalls = 0
  let mount: (() => void) | undefined
  const ambientLlm = {
    stream() {
      ambientPrepareCalls += 1
    },
    prepareCall() {
      ambientPrepareCalls += 1
      throw new Error('stock apply must not inspect ambient llm')
    },
  }
  const root: ClarifyHostContext = {
    llm: ambientLlm,
    sessions: {
      get(sessionId) {
        if (sessionId !== 'existing-session') return undefined
        return {
          id: sessionId,
          requestHeader: () => ({
            config: { provider: 'official', model: 'active', maxTokens: 512 },
            system: 'ordinary Session system',
            tools: [{ name: 'must-not-be-forwarded' }],
          }),
          requestContext: () => ({ provider: 'official', model: 'active', contextWindow: 64_000 }),
          deriveMessages: () => [{ role: 'user', content: [{ type: 'text', text: 'Build the requested feature.' }] }],
        }
      },
    },
    inject(deps, callback) {
      if (!Array.isArray(deps) || !deps.includes('typert')) return
      mount = () => {
        const typert = { register() {} }
        const ready = {
          typert,
          provide(name: string, value: unknown) {
            services.set(name, value)
          },
          get(name: string) {
            if (name === 'typert') return typert
            return services.get(name)
          },
        }
        callback(ready)
      }
      mount()
    },
  }
  apply(root)
  const remote = () => {
    const value = services.get('clarify')
    if (!value) throw new Error('Clarify Remote was not provided')
    return value as ClarifyRemote
  }
  return {
    ambientPrepareCalls: () => ambientPrepareCalls,
    remote,
    remount() {
      services.delete('clarify')
      mount?.()
      return remote()
    },
  }
}

function completedLlm(seen: { calls: number; options: PreparedGenerateOptions[] }): PreparedCallLlmLike {
  return {
    async prepareCall(config) {
      seen.calls += 1
      return {
        config,
        async *stream(options) {
          seen.options.push(options)
          yield {
            type: 'text-delta',
            text: JSON.stringify({
              kind: 'ask',
              question: 'Which compatibility boundary should the implementation preserve?',
              options: ['Current official Host', 'Current and previous minor'],
              multiple: false,
              allowCustom: true,
              draftPreview: 'Implement a context-aware feature while preserving the selected Host compatibility boundary.',
              materialChanges: ['grounded the draft in the active Session'],
            }),
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  }
}

describe('acceptance-only Host inference composition', () => {
  it('keeps stock apply unauthorized and at zero prepareCall operations until explicit composition', async () => {
    const harness = createHarness()
    const remote = harness.remote()
    const seen = { calls: 0, options: [] as PreparedGenerateOptions[] }
    const llm = completedLlm(seen)

    await expect(remote.start('existing-session', 'seed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', category: 'configuration' },
    })
    expect(seen.calls).toBe(0)
    expect(harness.ambientPrepareCalls()).toBe(0)

    const disposeClosed = composeAcceptedHostInference(remote, { llm, isDispatchAuthorized: () => false })
    await expect(remote.start('existing-session', 'seed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', category: 'configuration' },
    })
    expect(seen.calls).toBe(0)
    disposeClosed()

    const disposeOpen = composeAcceptedHostInference(remote, { llm, isDispatchAuthorized: () => true })
    const started = unwrapClarifyWire(await remote.start('existing-session', 'seed'))
    expect(started).toMatchObject({ status: 'running', kind: 'ask' })
    expect(seen.calls).toBe(1)
    expect(seen.options[0]).toMatchObject({ provider: 'official', model: 'active', sessionId: 'existing-session' })
    expect(seen.options[0]).not.toHaveProperty('tools')
    expect(seen.options[0]).not.toHaveProperty('purpose')
    await remote.cancel(started.processId)
    disposeOpen()
  })

  it('keeps composition single-active across Remote remounts and refuses an engine swap while running', async () => {
    const harness = createHarness()
    const first = harness.remote()
    const llm = completedLlm({ calls: 0, options: [] })
    const dispose = composeAcceptedHostInference(first, { llm, isDispatchAuthorized: () => true })
    const remounted = harness.remount()

    expect(remounted).not.toBe(first)
    expect(() => composeAcceptedHostInference(remounted, { llm, isDispatchAuthorized: () => true })).toThrowError(
      expect.objectContaining({ code: 'INFERENCE_UNAVAILABLE' }),
    )

    const started = unwrapClarifyWire(await remounted.start('existing-session', 'seed'))
    expect(() => composeAcceptedHostInference(remounted, { llm, isDispatchAuthorized: () => true })).toThrowError(
      expect.objectContaining({ code: 'PROCESS_BUSY' }),
    )
    await remounted.cancel(started.processId)
    dispose()
    const disposeAgain = composeAcceptedHostInference(remounted, { llm, isDispatchAuthorized: () => true })
    disposeAgain()
  })

  it('cancels an in-flight process before idempotently restoring Unauthorized', async () => {
    const harness = createHarness()
    const remote = harness.remote()
    let release: (() => void) | undefined
    let streamedSignal: AbortSignal | undefined
    const streamStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const llm: PreparedCallLlmLike = {
      async prepareCall(config) {
        calls += 1
        return {
          config,
          async *stream(options) {
            streamedSignal = options.signal
            release?.()
            await new Promise<void>((resolve) => {
              release = resolve
            })
          },
        }
      },
    }
    const dispose = composeAcceptedHostInference(remote, { llm, isDispatchAuthorized: () => true })
    const starting = remote.start('existing-session', 'seed')
    await streamStarted
    dispose()
    dispose()
    expect(streamedSignal?.aborted).toBe(true)
    release?.()
    await expect(starting).resolves.toMatchObject({ ok: true, value: { status: 'cancelled' } })
    await expect(remote.start('existing-session', 'seed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', category: 'configuration' },
    })
    expect(calls).toBe(1)
  })

  it('keeps the hook outside the explicit Typert/RPC method table', () => {
    const remote = createHarness().remote()
    expect(CLARIFY_REMOTE_METHODS).toEqual(['start', 'answer', 'accept', 'refine', 'cancel', 'fetchDraft'])
    expect(Object.keys(remote).sort()).toEqual(['accept', 'answer', 'cancel', 'fetchDraft', 'refine', 'start', 'typertRemote'].sort())
    expect(Object.getOwnPropertySymbols(remote)).toHaveLength(1)
    const [composeSymbol] = Object.getOwnPropertySymbols(remote)
    const rawCompose = (remote as unknown as Record<symbol, (payload: unknown) => unknown>)[composeSymbol!]
    expect(() => rawCompose?.({ infer: async () => ({}) })).toThrowError(
      expect.objectContaining({ code: 'INFERENCE_UNAVAILABLE' }),
    )
  })

  it('requires both a live Clarify acceptance hook and a callable authorization gate', () => {
    const llm = completedLlm({ calls: 0, options: [] })
    expect(() => composeAcceptedHostInference({}, { llm, isDispatchAuthorized: () => true })).toThrowError(
      expect.objectContaining({ code: 'INFERENCE_UNAVAILABLE' }),
    )
    expect(() => composeAcceptedHostInference(createHarness().remote(), { llm } as never)).toThrowError(
      expect.objectContaining({ code: 'INFERENCE_UNAVAILABLE' }),
    )
  })

  it('leaves the stock Clarify plugin injection graph independent of llm', () => {
    expect((apply as { inject?: unknown }).inject).toEqual({})
    expect([...TYPERT_READY_INJECT]).toEqual(['typert', 'typertGateway'])
  })
})

import { describe, expect, it } from 'vitest'
import type { AuxiliaryRuntimeLike } from '../src/auxiliary-runtime-inference.ts'
import { apply, AUXILIARY_READY_INJECT, type ClarifyHostContext } from '../src/index.ts'
import type { ClarifyRemote } from '../src/remote.ts'
import { unwrapClarifyWire } from '../src/types.ts'

const askJson = JSON.stringify({
  kind: 'ask',
  question: 'Which compatibility boundary materially changes this implementation?',
  options: ['Current Host only', 'Current and previous Host'],
  multiple: false,
  allowCustom: true,
  draftPreview: 'Implement the feature while preserving the selected compatibility boundary.',
  materialChanges: ['grounded compatibility in the live Session'],
})

function session() {
  return {
    id: 'existing-session',
    requestHeader: () => ({ config: { provider: 'official', model: 'active', maxTokens: 512 } }),
    requestContext: () => ({ provider: 'official', model: 'active', contextWindow: 64_000 }),
    deriveMessages: () => [{
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'Build the current feature.' }],
      source: { kind: 'user' },
    }],
  }
}

function mount(
  runtime?: AuxiliaryRuntimeLike,
  options: {
    session?: ReturnType<typeof session>
    defaultModel?: { provider: string; model: string; reasoningEffort?: string }
  } = {},
) {
  const services = new Map<string, unknown>()
  let disposeAuxiliary: (() => void) | undefined
  const root: ClarifyHostContext = {
    sessions: { get: (id) => id === 'existing-session' ? (options.session ?? session()) : undefined },
    ...options.defaultModel === undefined ? {} : {
      agentDefaultModel: { currentSelection: () => ({ ...options.defaultModel! }) },
    },
    inject(deps, callback) {
      if (!Array.isArray(deps)) return
      if (deps.includes('typert')) {
        const typert = { register() {} }
        callback({
          get(name) {
            if (name === 'typert') return typert
            return services.get(name)
          },
          provide(name, value) {
            services.set(name, value)
          },
          typert,
        })
      }
      if (deps.includes('auxiliaryRuntime') && runtime) {
        callback({
          get(name) {
            return name === 'auxiliaryRuntime' ? runtime : services.get(name)
          },
          effect(factory) {
            const disposer = factory()
            if (typeof disposer === 'function') disposeAuxiliary = disposer
          },
        })
      }
    },
  }
  apply(root)
  return {
    remote: services.get('clarify') as ClarifyRemote,
    disposeAuxiliary: () => disposeAuxiliary?.(),
  }
}

describe('automatic production composition', () => {
  it('starts on a truly empty Session through the public default model and prepared context', async () => {
    let seenConfig: unknown
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        seenConfig = request.config
        request.prepareRequest({
          config: { ...request.config, maxTokens: 640 },
          context: { contextWindow: 64_000 },
          adapterDefaults: { maxTokens: true },
        })
        return { status: 'succeeded', output: askJson }
      },
    }
    const empty = {
      id: 'existing-session',
      requestHeader: () => undefined,
      requestContext: () => undefined,
      deriveMessages: () => [],
    }
    const harness = mount(runtime, {
      session: empty as ReturnType<typeof session>,
      defaultModel: { provider: 'default-provider', model: 'default-model', reasoningEffort: 'high' },
    })
    const started = unwrapClarifyWire(await harness.remote.start('existing-session', 'seed'))
    expect(started.kind).toBe('ask')
    expect(seenConfig).toEqual({
      provider: 'default-provider',
      model: 'default-model',
      reasoningEffort: 'high',
    })
  })

  it('activates only through the optional auxiliaryRuntime child fiber', async () => {
    let calls = 0
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        calls += 1
        const built = request.prepareRequest({
          config: { ...request.config, maxTokens: 640 },
          context: { contextWindow: 64_000 },
          adapterDefaults: { maxTokens: true },
        })
        expect(request.purpose).toBe('clarify')
        expect(request.signal).toBeInstanceOf(AbortSignal)
        expect(built).not.toHaveProperty('tools')
        expect(JSON.stringify(built)).not.toContain('must-not-be-forwarded')
        return { status: 'succeeded', output: askJson }
      },
    }
    const harness = mount(runtime)
    const started = unwrapClarifyWire(await harness.remote.start('existing-session', 'seed'))
    expect(started).toMatchObject({ status: 'running', kind: 'ask' })
    expect(calls).toBe(1)
    await harness.remote.cancel(started.processId)
  })

  it('keeps Clarify mounted but fails closed when auxiliaryRuntime is absent', async () => {
    const harness = mount()
    await expect(harness.remote.start('existing-session', 'seed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', category: 'configuration' },
    })
  })

  it('cancels in-flight work before deactivating on auxiliary fiber disposal', async () => {
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const runtime: AuxiliaryRuntimeLike = {
      async run(request) {
        started()
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { status: 'cancelled', output: null, failure: { category: 'aborted', code: 'ABORTED' } }
      },
    }
    const harness = mount(runtime)
    const starting = harness.remote.start('existing-session', 'seed')
    await entered
    harness.disposeAuxiliary()
    await expect(starting).resolves.toMatchObject({ ok: true, value: { status: 'cancelled' } })
    await expect(harness.remote.start('existing-session', 'seed')).resolves.toMatchObject({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE' },
    })
  })

  it('declares the narrow optional service injection separately from Typert/Web', () => {
    expect([...AUXILIARY_READY_INJECT]).toEqual(['auxiliaryRuntime'])
    expect((apply as { inject?: unknown }).inject).toEqual({})
  })
})

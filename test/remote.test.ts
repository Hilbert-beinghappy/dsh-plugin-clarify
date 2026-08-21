import { describe, expect, it } from 'vitest'
import { ClarifyService } from '../src/clarify-service.ts'
import { PINNED_CONTRACT_VERSIONS, uniqueContractVersions as scriptUnique } from '../scripts/lib/versions.mjs'
import { CLARIFY_REMOTE_METHODS, PINNED_CONTRACT_VERSIONS as srcPinned, uniqueContractVersions } from '../src/compat.ts'
import { clarifyClientRequest } from '../src/remote-client.ts'
import { clarifyDiyHtml } from '../src/host-diy.ts'
import { apply, TYPERT_READY_INJECT } from '../src/index.ts'
import { clarifyTypertContribution, createClarifyRemote, registerClarifyRemote } from '../src/remote.ts'
import { StubInferenceEngine } from './fixtures/stub-inference.mjs'
import { unwrapClarifyWire, type HostBinding } from '../src/types.ts'

function service(): ClarifyService {
  const binding: HostBinding = {
    sessionId: 'session-remote',
    contextVersion: 'ctx-remote',
    modelRouteId: 'route-remote',
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

describe('Typert Remote registration', () => {
  it('exposes SRC-safe named methods and a consistent typertRemote binding', async () => {
    const remote = createClarifyRemote(service())
    expect(remote.typertRemote.namespace).toBe('clarify')
    expect(remote.typertRemote.serviceKey).toBe('clarify')
    expect(remote.typertRemote.service).toBe(remote)
    const started = unwrapClarifyWire(await remote.start('session-remote', 'seed'))
    expect(started.status).toBe('running')
    expect(started).not.toHaveProperty('draft')
  })

  it('registers a host contribution with the stock endpoints', () => {
    const contribution = clarifyTypertContribution()
    expect(contribution.face).toBe('host')
    expect(contribution).not.toHaveProperty('descriptors')
    const invocations = contribution.invocations as Array<{ namespace: string; method: string }>
    expect(invocations.map((item) => `${item.namespace}/${item.method}`)).toEqual([
      'clarify/start',
      'clarify/answer',
      'clarify/accept',
      'clarify/refine',
      'clarify/cancel',
      'clarify/fetchDraft',
    ])
  })

  it('uses ctx.typert.register when provide/reflect returns the live Service', () => {
    const registered: unknown[] = []
    const provided: Record<string, unknown> = {}
    const result = registerClarifyRemote({
      provide(name, value) {
        provided[name] = value
      },
      get(name) {
        if (name === 'typert') {
          return {
            register(contribution: unknown) {
              registered.push(contribution)
            },
          }
        }
        return provided[name]
      },
    }, service())
    expect(result.status).toBe('registered')
    expect(result.mode).toBe('typert.register')
    expect(result.liveService.sameIdentity).toBe(true)
    expect(provided.clarify).toBeTruthy()
    expect(registered).toHaveLength(1)
    expect((registered[0] as { face?: string }).face).toBe('host')
  })

  it('degrades when provide does not reflect the same live Service', () => {
    const result = registerClarifyRemote({
      provide() {},
      get() {
        return { register() {} }
      },
    }, service())
    expect(result.status).toBe('degraded')
    expect(result.liveService.sameIdentity).toBe(false)
    expect(result.reason).toMatch(/live Service/)
  })

  it('does not register until the typert child fiber is ready', () => {
    const registered: unknown[] = []
    apply({
      inject() {
        // Host has not delivered typert yet.
      },
    })
    expect(registered).toHaveLength(0)
  })

  it('waits for typert on a child fiber before provide/register', () => {
    const registered: unknown[] = []
    const provided: Record<string, unknown> = {}
    const injectCalls: unknown[] = []
    apply({
      inject(deps, callback) {
        injectCalls.push(deps)
        if (!Array.isArray(deps) || !deps.includes('typert')) return
        const typert = {
          register(contribution: unknown) {
            registered.push(contribution)
          },
        }
        const ready = {
          typert,
          provide(name: string, value: unknown) {
            provided[name] = value
          },
          get(name: string) {
            if (name === 'typert') return typert
            return provided[name]
          },
        }
        callback(ready)
      },
    })
    expect(injectCalls).toContainEqual([...TYPERT_READY_INJECT])
    expect(registered).toHaveLength(1)
    expect(provided.clarify).toBeTruthy()
  })

  it('keeps plugin-level inject empty so apply is not bound to unrelated Host services', () => {
    expect((apply as { inject?: unknown }).inject).toEqual({})
    expect([...TYPERT_READY_INJECT]).toEqual(['typert', 'typertGateway'])
  })

  it('registers when strict ctx.get cannot yet see a LOADING provide', () => {
    const registered: unknown[] = []
    const provided: Record<string, unknown> = {}
    const result = registerClarifyRemote({
      provide(name, value) {
        provided[name] = value
      },
      get(name, strict = true) {
        if (name === 'typert') {
          return {
            register(contribution: unknown) {
              registered.push(contribution)
            },
          }
        }
        if (strict) return undefined
        return provided[name]
      },
    }, service())
    expect(result.status).toBe('registered')
    expect(result.liveService.sameIdentity).toBe(true)
    expect(registered).toHaveLength(1)
  })

  it('degrades safely when typert.register is absent', () => {
    const provided: Record<string, unknown> = {}
    const result = registerClarifyRemote({
      provide(name, value) {
        provided[name] = value
      },
      get(name) {
        return provided[name]
      },
    }, service())
    expect(result.status).toBe('degraded')
    expect(result.mode).toBe('service-only')
    expect(result.reason).toMatch(/typert\.register/)
  })
})

describe('Remote answer omit keeps strict XOR', () => {
  it('omits empty customText so an option-only positional answer is valid', async () => {
    const remote = createClarifyRemote(service())
    const started = unwrapClarifyWire(await remote.start('session-remote', 'seed'))
    const next = unwrapClarifyWire(await remote.answer(
      started.processId,
      started.question!.questionId,
      started.previewVersion!,
      [optionId(started.question!, 'Add a feature')],
      '',
    ))
    expect(next.status).toBe('running')
    expect(next.question?.text).toContain('constraints')
  })

  it('omits empty selectedOptionIds so a custom-only positional answer is valid', async () => {
    const remote = createClarifyRemote(service())
    const started = unwrapClarifyWire(await remote.start('session-remote', 'seed'))
    const next = unwrapClarifyWire(await remote.answer(
      started.processId,
      started.question!.questionId,
      started.previewVersion!,
      [],
      'ship a clarify plugin',
    ))
    expect(next.status).toBe('running')
    expect(next.question?.text).toContain('constraints')
  })

  it('still rejects when both sides of the XOR are non-empty', async () => {
    const remote = createClarifyRemote(service())
    const started = unwrapClarifyWire(await remote.start('session-remote', 'seed'))
    await expect(
      remote.answer(
        started.processId,
        started.question!.questionId,
        started.previewVersion!,
        [optionId(started.question!, 'Add a feature')],
        'also custom',
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_ANSWER', category: 'invalid-request' },
    })
  })
})

describe('official consumer envelope', () => {
  it('builds POST /api client-request envelopes with named args', () => {
    const envelope = clarifyClientRequest('start', { sessionId: 's1', seedText: 'x' }, 'rpc-1')
    expect(envelope).toEqual({
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'clarify/start',
      payload: { args: { sessionId: 's1', seedText: 'x' } },
    })
  })

  it('omits empty customText and empty selectedOptionIds from answer envelopes', () => {
    expect(clarifyClientRequest('answer', {
      processId: 'p',
      questionId: 'q',
      previewVersion: 'v1',
      selectedOptionIds: ['o-feature'],
      customText: '',
    }).payload.args).toEqual({
      processId: 'p',
      questionId: 'q',
      previewVersion: 'v1',
      selectedOptionIds: ['o-feature'],
    })
    expect(clarifyClientRequest('answer', {
      processId: 'p',
      questionId: 'q',
      previewVersion: 'v1',
      selectedOptionIds: [],
      customText: 'hello',
    }).payload.args).toEqual({
      processId: 'p',
      questionId: 'q',
      previewVersion: 'v1',
      customText: 'hello',
    })
  })
})

describe('Host DIY surface', () => {
  it('is an operable Web page that only talks to the same Remote', () => {
    const html = clarifyDiyHtml()
    expect(html).toContain('window.CLARIFY_REMOTE')
    expect(html).toContain('/api/')
    expect(html).toContain('clarify/start')
    expect(html).toContain('Fetch draft')
    expect(html).toContain('Copy draft')
    expect(html).toContain('Current draft preview')
    expect(html).toContain('Changes this round')
    expect(html).toContain("typeof echo.draftPreview === 'string'")
    expect(html).toContain('clarify.wire/1')
    expect(html).toContain("error.category !== 'conflict'")
    expect(html).toContain('Refine preview')
    expect(html).toContain('item.textContent = change')
    expect(html).not.toContain('/clarify/rpc')
    expect(html).not.toContain('session.prompt')
    expect(html).not.toContain('session.create')
    expect(html).toContain('existing Host session')
    for (const method of CLARIFY_REMOTE_METHODS) {
      expect(html).toContain(method)
    }
  })
})

describe('compatibility matrix helpers', () => {
  it('keeps script and src pinned lanes identical', () => {
    expect([...scriptUnique({ latest: '0.1.0-rc.7', next: '0.1.0-rc.8' })]).toEqual(
      uniqueContractVersions({ latest: '0.1.0-rc.7', next: '0.1.0-rc.8' }),
    )
    expect([...PINNED_CONTRACT_VERSIONS]).toEqual([...srcPinned])
  })

  it('pins rc.6 + rc.7 + rc.8 + 0.1.1-rc.2 and dedupes latest/next onto those exact versions', () => {
    expect([...srcPinned]).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
    expect(srcPinned).not.toContain('0.1.1-rc.1')
    expect(uniqueContractVersions({
      latest: '0.1.0-rc.7',
      next: '0.1.0-rc.8',
    })).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
    expect(uniqueContractVersions({
      latest: '0.1.0-rc.7',
      next: '0.1.1-rc.2',
    })).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
    expect(uniqueContractVersions({
      latest: '0.1.1-rc.2',
      next: '0.1.1-rc.2',
    })).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
  })

  it('keeps pinned rc.8 and 0.1.1-rc.2 even when next equals latest', () => {
    expect(uniqueContractVersions({
      latest: '0.1.0-rc.7',
      next: '0.1.0-rc.7',
    })).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
  })

  it('adds a newer discovered latest/next without dropping pinned lanes', () => {
    expect(uniqueContractVersions({
      latest: '0.1.0-rc.9',
      next: '0.1.0-rc.10',
    })).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2', '0.1.0-rc.9', '0.1.0-rc.10'])
  })

  it('does not put historical 0.1.1-rc.1 into the default pin set when latest=next=rc.2', () => {
    const versions = uniqueContractVersions({
      latest: '0.1.1-rc.2',
      next: '0.1.1-rc.2',
    })
    expect(versions).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
    expect(versions).not.toContain('0.1.1-rc.1')
  })
})

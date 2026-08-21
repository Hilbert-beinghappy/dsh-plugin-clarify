import { describe, expect, it } from 'vitest'
import { ClarifyService } from '../src/clarify-service.ts'
import { createClarifyRemote } from '../src/remote.ts'
import { StubInferenceEngine } from './fixtures/stub-inference.mjs'
import {
  CLARIFY_WIRE_PROTOCOL,
  ClarifyError,
  type ClarifyWireResult,
  type HostBinding,
  unwrapClarifyWire,
} from '../src/types.ts'

const binding: HostBinding = {
  sessionId: 'session-wire',
  contextVersion: 'ctx-wire',
  modelRouteId: 'route-wire',
}

function service(overrides: ConstructorParameters<typeof ClarifyService>[0] = {
  resolveBinding: () => binding,
  inference: new StubInferenceEngine(),
}): ClarifyService {
  return new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
    ...overrides,
  })
}

function optionId(question: { options: Array<{ optionId: string; text: string }> }, text: string): string {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

function officialGatewayInvoke<T>(fn: () => Promise<T>): Promise<{
  readonly ok: true
  readonly value: T
} | {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, never> }
}> {
  return fn().then(
    (value) => ({ ok: true, value }),
    (error: unknown) => {
      const name = error instanceof Error ? error.name : ''
      if (name === 'AbortError' || name === 'RemoteInvocationCancelled') {
        return {
          ok: false,
          error: {
            code: 'cancelled',
            message: error instanceof Error ? error.message : 'cancelled',
            details: {},
          },
        }
      }
      return {
        ok: false,
        error: {
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
      }
    },
  )
}

describe('clarify.wire/1 Remote envelope', () => {
  it('returns Gateway-safe success wrappers for all six methods', async () => {
    const remote = createClarifyRemote(service())
    const started = await remote.start('session-wire', 'seed')
    expect(started).toEqual({
      protocol: CLARIFY_WIRE_PROTOCOL,
      ok: true,
      value: expect.objectContaining({ status: 'running', sessionId: 'session-wire' }),
    })
    const echo = unwrapClarifyWire(started)
    const answered = await remote.answer(
      echo.processId,
      echo.question!.questionId,
      echo.previewVersion!,
      [optionId(echo.question!, 'Add a feature')],
      '',
    )
    expect(answered.protocol).toBe(CLARIFY_WIRE_PROTOCOL)
    expect(answered.ok).toBe(true)
    const ready = unwrapClarifyWire(answered)
    const refined = await remote.refine(echo.processId, ready.previewVersion!, 'add rollback')
    expect(unwrapClarifyWire(refined).status).toBe('running')
    const completed = await remote.accept(echo.processId, unwrapClarifyWire(refined).previewVersion!)
    expect(unwrapClarifyWire(completed).status).toBe('complete')
    const fetched = await remote.fetchDraft(echo.processId)
    expect(unwrapClarifyWire(fetched).draft).toEqual(expect.any(String))
    const live = unwrapClarifyWire(await remote.start('session-wire', 'to cancel'))
    const cancelled = await remote.cancel(live.processId)
    expect(unwrapClarifyWire(cancelled).status).toBe('cancelled')
  })

  it('wraps ClarifyError as outer success inner-v1 instead of throwing', async () => {
    const remote = createClarifyRemote(service())
    const missing = await remote.fetchDraft('missing-process')
    expect(missing).toEqual({
      protocol: CLARIFY_WIRE_PROTOCOL,
      ok: false,
      error: {
        code: 'PROCESS_NOT_FOUND',
        message: 'process missing-process does not exist',
        category: 'conflict',
      },
    })
    const envelope = await officialGatewayInvoke(() => remote.fetchDraft('missing-process'))
    expect(envelope.ok).toBe(true)
    expect(envelope).toMatchObject({
      ok: true,
      value: {
        protocol: CLARIFY_WIRE_PROTOCOL,
        ok: false,
        error: { code: 'PROCESS_NOT_FOUND', category: 'conflict' },
      },
    })
  })

  it('proves the official-gateway defect: ordinary thrown ClarifyError becomes outer internal', async () => {
    const thrown = officialGatewayInvoke(async () => {
      throw new ClarifyError('PROCESS_BUSY', 'process is already inferring', 'conflict')
    })
    await expect(thrown).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'process is already inferring',
        details: {},
      },
    })
  })

  it('returns configuration on missing model route as outer success and creates no process', async () => {
    const remote = createClarifyRemote(service({
      resolveBinding: () => {
        throw new ClarifyError('INFERENCE_UNAVAILABLE', 'inference snapshot is missing its model route', 'configuration')
      },
    }))
    const started = await officialGatewayInvoke(() => remote.start('session-wire', 'seed'))
    expect(started).toEqual({
      ok: true,
      value: {
        protocol: CLARIFY_WIRE_PROTOCOL,
        ok: false,
        error: {
          code: 'INFERENCE_UNAVAILABLE',
          message: 'inference snapshot is missing its model route',
          category: 'configuration',
        },
      },
    })
    expect(JSON.stringify(started)).not.toMatch(/processId/)
    const again = await remote.fetchDraft('should-not-exist')
    expect(again).toMatchObject({
      ok: false,
      error: { code: 'PROCESS_NOT_FOUND', category: 'conflict' },
    })
  })

  it('wraps unknown pre-process resolveBinding failures as configuration and creates no process', async () => {
    const remote = createClarifyRemote(service({
      resolveBinding: () => {
        throw new Error('sessions.get exploded')
      },
    }))
    const started = await remote.start('session-wire', 'seed')
    expect(started).toEqual({
      protocol: CLARIFY_WIRE_PROTOCOL,
      ok: false,
      error: {
        code: 'INFERENCE_UNAVAILABLE',
        message: 'sessions.get exploded',
        category: 'configuration',
      },
    })
  })

  it('keeps start-time missing public Session as protocol PROCESS_NOT_FOUND', async () => {
    const remote = createClarifyRemote(service({
      resolveBinding: (sessionId) => {
        throw new ClarifyError(
          'PROCESS_NOT_FOUND',
          `session ${sessionId} is not available through the public sessions service`,
          'protocol',
        )
      },
    }))
    expect(await remote.start('ghost-session', '')).toEqual({
      protocol: CLARIFY_WIRE_PROTOCOL,
      ok: false,
      error: {
        code: 'PROCESS_NOT_FOUND',
        message: 'session ghost-session is not available through the public sessions service',
        category: 'protocol',
      },
    })
  })

  it('rethrows carrier cancellation instead of wrapping it', async () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    const remote = createClarifyRemote(service({
      resolveBinding: () => {
        throw abort
      },
    }))
    await expect(remote.start('session-wire', '')).rejects.toMatchObject({ name: 'AbortError' })
    const envelope = await officialGatewayInvoke(() => remote.start('session-wire', ''))
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'This operation was aborted', details: {} },
    })
  })

  it('classifies XOR as invalid-request and non-material preview as retryable', async () => {
    const remote = createClarifyRemote(service())
    const started = unwrapClarifyWire(await remote.start('session-wire', 'seed'))
    const xor = await remote.answer(
      started.processId,
      started.question!.questionId,
      started.previewVersion!,
      [optionId(started.question!, 'Add a feature')],
      'also custom',
    )
    expect(xor).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ANSWER', category: 'invalid-request' },
    })

    const material = service({
      inference: {
        async infer() {
          return {
            kind: 'ask',
            question: 'Same preview?',
            options: ['Yes'],
            multiple: false,
            allowCustom: false,
            draftPreview: 'unchanged preview',
            materialChanges: ['claimed a change'],
          }
        },
      },
      resolveBinding: () => binding,
    })
    const live = createClarifyRemote(material)
    const first = unwrapClarifyWire(await live.start('session-wire', 'seed'))
    expect(first.draftPreview).toBe('unchanged preview')
    const next = await live.answer(
      first.processId,
      first.question!.questionId,
      first.previewVersion!,
      [first.question!.options[0]!.optionId],
      '',
    )
    expect(next).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ANSWER',
        message: 'inference preview is not a material change',
        category: 'retryable',
      },
    })
  })

  it('classifies PROCESS_BUSY and unknown process as conflict', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const inferring = service({
      inference: {
        async infer() {
          await hold
          return {
            kind: 'await_accept',
            draftPreview: 'held preview',
            materialChanges: ['finished after hold'],
          }
        },
      },
    })
    const remote = createClarifyRemote(inferring)
    const starting = remote.start('session-wire', 'seed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    const ids = inferring.runningProcessIds()
    expect(ids).toHaveLength(1)
    const busy = await remote.answer(ids[0]!, 'q', 'pv', ['o'], '')
    expect(busy).toMatchObject({
      ok: false,
      error: { code: 'PROCESS_BUSY', category: 'conflict' },
    })
    release()
    await starting
  })

  it('rethrows non-ClarifyError from Remote without inventing a category', async () => {
    const clarify = service()
    clarify.fetchDraft = async () => {
      throw new TypeError('unexpected carrier')
    }
    const remote = createClarifyRemote(clarify)
    await expect(remote.fetchDraft('any')).rejects.toBeInstanceOf(TypeError)
    const envelope = await officialGatewayInvoke(() => remote.fetchDraft('any'))
    expect(envelope).toEqual({
      ok: false,
      error: { code: 'internal', message: 'unexpected carrier', details: {} },
    })
  })
})

describe('JSON-safe wire values', () => {
  it('keeps success and failure payloads JSON-serializable', async () => {
    const remote = createClarifyRemote(service())
    const started = await remote.start('session-wire', 'seed')
    expect(JSON.parse(JSON.stringify(started))).toEqual(started)
    const missing = await remote.fetchDraft('gone')
    expect(JSON.parse(JSON.stringify(missing))).toEqual(missing)
    const empty: ClarifyWireResult<never> = missing
    expect(empty.ok).toBe(false)
  })
})

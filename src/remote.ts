import { ClarifyService } from './clarify-service.ts'
import {
  CLARIFY_REMOTE_METHODS,
  CLARIFY_REMOTE_NAMESPACE,
  detectHostCapabilities,
  peekHost,
  type HostLike,
  type TypertLike,
} from './compat.ts'
import { dispatchClarifyRpc } from './rpc.ts'
import type { AnswerResponse, CancelResponse, FetchDraftResponse, StartResponse } from './types.ts'

export const CLARIFY_PACKAGE = 'dsh-plugin-clarify'

export interface ClarifyRemote {
  readonly typertRemote: {
    readonly service: ClarifyRemote
    readonly serviceKey: string
    readonly namespace: string
  }
  start(sessionId: string, seedText: string): Promise<StartResponse>
  answer(
    processId: string,
    questionId: string,
    selectedOptionIds: string[],
    customText: string,
  ): Promise<AnswerResponse>
  cancel(processId: string): Promise<CancelResponse>
  fetchDraft(processId: string): Promise<FetchDraftResponse>
}

export interface RemoteRegistration {
  status: 'registered' | 'degraded'
  mode: 'typert.register' | 'service-only'
  namespace: string
  methods: readonly string[]
  endpoints: readonly string[]
  liveService: {
    provided: boolean
    reflected: boolean
    sameIdentity: boolean
  }
  reason?: string
}

export function createClarifyRemote(service: ClarifyService): ClarifyRemote {
  const remote: ClarifyRemote = {
    get typertRemote() {
      return binding
    },
    async start(sessionId, seedText) {
      return await dispatchClarifyRpc(service, 'start', omitUndefined({
        sessionId,
        seedText,
      }))
    },
    async answer(processId, questionId, selectedOptionIds, customText) {
      return await dispatchClarifyRpc(service, 'answer', omitUndefined({
        processId,
        questionId,
        selectedOptionIds,
        customText,
      }))
    },
    async cancel(processId) {
      return await dispatchClarifyRpc(service, 'cancel', { processId })
    },
    async fetchDraft(processId) {
      return await dispatchClarifyRpc(service, 'fetchDraft', { processId })
    },
  }
  const binding = Object.freeze({
    service: remote,
    serviceKey: CLARIFY_REMOTE_NAMESPACE,
    namespace: CLARIFY_REMOTE_NAMESPACE,
  })
  return remote
}

export function clarifyInvocationDescriptors(): readonly Record<string, unknown>[] {
  return [
    descriptor('start', [
      param('sessionId'),
      param('seedText'),
    ]),
    descriptor('answer', [
      param('processId'),
      param('questionId'),
      param('selectedOptionIds'),
      param('customText'),
    ]),
    descriptor('cancel', [param('processId')]),
    descriptor('fetchDraft', [param('processId')]),
  ]
}

/** Host `TypertContribution` for `ctx.typert.register`. Not a Client `$mount` `TypertRemoteContribution`. */
export function clarifyTypertContribution(): Record<string, unknown> {
  return {
    package: CLARIFY_PACKAGE,
    face: 'host',
    schemas: [],
    model: {
      services: [{
        key: CLARIFY_REMOTE_NAMESPACE,
        exportName: 'ClarifyRemote',
        members: CLARIFY_REMOTE_METHODS.map((method) => ({
          kind: 'method',
          name: method,
          signature: `${method}(...)`,
        })),
        types: [],
      }],
      events: [],
      objects: [],
    },
    invocations: clarifyInvocationDescriptors(),
  }
}

let lastRegistration: RemoteRegistration | undefined

export function lastClarifyRemoteRegistration(): RemoteRegistration | undefined {
  return lastRegistration
}

export function registerClarifyRemote(ctx: HostLike, service: ClarifyService): RemoteRegistration {
  const remote = createClarifyRemote(service)
  const endpoints = CLARIFY_REMOTE_METHODS.map((method) => `${CLARIFY_REMOTE_NAMESPACE}/${method}`)
  const capabilities = detectHostCapabilities(ctx)
  const liveService = { provided: false, reflected: false, sameIdentity: false }
  const remember = (result: RemoteRegistration): RemoteRegistration => {
    lastRegistration = result
    return result
  }
  try {
    ctx.provide?.(CLARIFY_REMOTE_NAMESPACE, remote)
    liveService.provided = true
  } catch (error) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: CLARIFY_REMOTE_NAMESPACE,
      methods: CLARIFY_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: errorMessage(error, 'ctx.provide(clarify) failed'),
    })
  }

  const reflected = peekHost(ctx, CLARIFY_REMOTE_NAMESPACE)
  liveService.reflected = reflected !== undefined
  liveService.sameIdentity = reflected === remote

  const typert = callerTypert(ctx)
  if (typeof typert?.register !== 'function') {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: CLARIFY_REMOTE_NAMESPACE,
      methods: CLARIFY_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: capabilities.typertRegister.detail,
    })
  }
  if (!liveService.sameIdentity) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: CLARIFY_REMOTE_NAMESPACE,
      methods: CLARIFY_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: 'ctx.provide(clarify) did not reflect the same live Service; Gateway receiver is not proven',
    })
  }
  try {
    // Prefer the fiber-proxied ctx.typert so this.ctx.effect binds to the
    // same inject child that owns provide(clarify).
    typert.register(clarifyTypertContribution())
    return remember({
      status: 'registered',
      mode: 'typert.register',
      namespace: CLARIFY_REMOTE_NAMESPACE,
      methods: CLARIFY_REMOTE_METHODS,
      endpoints,
      liveService,
    })
  } catch (error) {
    return remember({
      status: 'degraded',
      mode: 'service-only',
      namespace: CLARIFY_REMOTE_NAMESPACE,
      methods: CLARIFY_REMOTE_METHODS,
      endpoints,
      liveService,
      reason: errorMessage(error, 'ctx.typert.register rejected the Host TypertContribution'),
    })
  }
}

function callerTypert(ctx: HostLike): TypertLike | undefined {
  try {
    const proxied = ctx.typert
    if (typeof proxied?.register === 'function') return proxied
  } catch {
    // undeclared Cordis access throws; fall through
  }
  const peeked = peekHost(ctx, 'typert') as TypertLike | undefined
  return typeof peeked?.register === 'function' ? peeked : undefined
}

function descriptor(method: string, parameters: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: `${CLARIFY_PACKAGE}#${CLARIFY_REMOTE_NAMESPACE}/${method}`,
    service: CLARIFY_REMOTE_NAMESPACE,
    namespace: CLARIFY_REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters,
    result: { mode: 'src-json' },
  }
}

function param(name: string): Record<string, unknown> {
  return {
    name,
    wire: name,
    source: 'json',
    codec: { mode: 'src-json' },
  }
}

function omitUndefined(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.length === 0 && key !== 'sessionId' && key !== 'processId' && key !== 'questionId') {
      continue
    }
    if (key === 'selectedOptionIds' && Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

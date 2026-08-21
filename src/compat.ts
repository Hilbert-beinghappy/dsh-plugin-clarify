import { captureInferenceSnapshot } from './inference-snapshot.ts'
import { ClarifyError, type ResolvedHostBinding } from './types.ts'

export const CLARIFY_REMOTE_NAMESPACE = 'clarify'
export const CLARIFY_REMOTE_METHODS = ['start', 'answer', 'accept', 'refine', 'cancel', 'fetchDraft'] as const
export type ClarifyRemoteMethod = (typeof CLARIFY_REMOTE_METHODS)[number]

export const MINIMUM_DSH_VERSION = '0.1.0-rc.6'
export const PINNED_CONTRACT_VERSIONS = ['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8'] as const

export interface HostLike {
  get?: (name: string, strict?: boolean) => unknown
  provide?: (name: string, value: unknown) => unknown
  inject?: (deps: string[] | Record<string, unknown>, callback: (ctx: HostLike) => void) => unknown
  effect?: (factory: () => void | (() => void)) => void
  typert?: TypertLike
  typertGateway?: TypertGatewayLike
  sessions?: SessionsCapability
  webServer?: { register?: unknown; port?: number; host?: string }
  llm?: { stream?: unknown; registerAdapter?: unknown }
  tokenMeter?: { measure?: unknown }
  connection?: { rpc?: { intercept?: unknown; call?: unknown } }
  remote?: { $mount?: unknown }
  clientModules?: unknown
}

export interface TypertLike {
  register?: (contribution: unknown) => unknown
  local?: {
    get?: (endpoint: string) => unknown
    list?: () => unknown[]
    hasSeen?: (endpoint: string) => boolean
  }
}

export interface TypertGatewayLike {
  invoke?: (request: {
    namespace: string
    method: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }) => Promise<unknown>
}

export interface SessionsCapability {
  get?: (sessionId: string) => SessionCapability | undefined
  create?: (id?: string, options?: { meta?: { cwd?: string } }) => SessionCapability
  list?: () => unknown[]
}

export interface SessionCapability {
  id?: string
  requestHeader?: () => { config?: Record<string, unknown>; system?: unknown; tools?: unknown } | undefined
  deriveMessages?: () => unknown
  requestContext?: () => unknown
  seq?: unknown
}

export type CapabilityStatus = 'available' | 'unavailable' | 'degraded'

export interface CapabilityNote {
  status: CapabilityStatus
  detail: string
}

export interface HostCapabilities {
  typertRegister: CapabilityNote
  typertGatewayInvoke: CapabilityNote
  sessionsGet: CapabilityNote
  requestHeader: CapabilityNote
  llmStream: CapabilityNote
  tokenMeter: CapabilityNote
  webServerRegister: CapabilityNote
  connectionRpc: CapabilityNote
  clientRemoteMount: CapabilityNote
}

export function peekHost(ctx: object | undefined, name: string): unknown {
  if (!ctx || typeof ctx !== 'object') return undefined
  const record = ctx as HostLike
  let getter: HostLike['get']
  try {
    getter = record.get
  } catch {
    getter = undefined
  }
  if (typeof getter === 'function') {
    try {
      const loose = getter.call(record, name, false)
      if (loose !== undefined) return loose
    } catch {
      // declared-but-waiting Cordis services throw; try strict/property next
    }
    try {
      const value = getter.call(record, name)
      if (value !== undefined) return value
    } catch {
      // fall through to own properties
    }
  }
  try {
    return (record as Record<string, unknown>)[name]
  } catch {
    return undefined
  }
}

export function detectHostCapabilities(ctx: object | undefined): HostCapabilities {
  const typert = peekHost(ctx, 'typert') as TypertLike | undefined
  const gateway = peekHost(ctx, 'typertGateway') as TypertGatewayLike | undefined
  const sessions = peekHost(ctx, 'sessions') as SessionsCapability | undefined
  const webServer = peekHost(ctx, 'webServer') as HostLike['webServer']
  const llm = peekHost(ctx, 'llm') as HostLike['llm']
  const tokenMeter = peekHost(ctx, 'tokenMeter') as HostLike['tokenMeter']
  const connection = peekHost(ctx, 'connection') as HostLike['connection']
  const remote = peekHost(ctx, 'remote') as HostLike['remote']
  return {
    typertRegister: note(typeof typert?.register === 'function', 'ctx.typert.register'),
    typertGatewayInvoke: note(typeof gateway?.invoke === 'function', 'ctx.typertGateway.invoke'),
    sessionsGet: note(typeof sessions?.get === 'function', 'ctx.sessions.get'),
    requestHeader: {
      status: typeof sessions?.get === 'function' ? 'degraded' : 'unavailable',
      detail: 'fresh sessions may omit requestHeader(); inference then fails closed and never uses session.seq as context identity',
    },
    llmStream: note(typeof llm?.stream === 'function', 'ctx.llm.stream'),
    tokenMeter: note(typeof tokenMeter?.measure === 'function', 'ctx.tokenMeter.measure'),
    webServerRegister: note(typeof webServer?.register === 'function', 'ctx.webServer.register'),
    connectionRpc: note(
      typeof connection?.rpc?.intercept === 'function' || typeof connection?.rpc?.call === 'function',
      'ctx.connection.rpc',
    ),
    clientRemoteMount: note(typeof remote?.$mount === 'function', 'ctx.remote.$mount (Client face)'),
  }
}

export function resolveBindingSafely(sessions: SessionsCapability | undefined, sessionId: string): ResolvedHostBinding {
  const session = sessions?.get?.(sessionId)
  if (!session) {
    throw new ClarifyError('PROCESS_NOT_FOUND', `session ${sessionId} is not available through the public sessions service`, 'protocol')
  }
  if (typeof session.seq === 'number' || typeof session.seq === 'string') {
    // session.seq is observed but forbidden as contextVersion.
  }
  const snapshot = captureInferenceSnapshot(sessionId, session)
  return {
    sessionId,
    contextVersion: snapshot.contextVersion,
    modelRouteId: snapshot.modelRouteId,
    snapshot,
  }
}

export function uniqueContractVersions(options: {
  latest?: string
  next?: string
  extra?: readonly string[]
}): string[] {
  const versions = new Set<string>(PINNED_CONTRACT_VERSIONS)
  for (const extra of options.extra ?? []) {
    if (extra) versions.add(extra)
  }
  if (options.latest) versions.add(options.latest)
  if (options.next && options.next !== options.latest) versions.add(options.next)
  return [...versions]
}

function note(available: boolean, surface: string): CapabilityNote {
  return available
    ? { status: 'available', detail: `${surface} is present` }
    : { status: 'unavailable', detail: `${surface} is not a public function on this Host` }
}

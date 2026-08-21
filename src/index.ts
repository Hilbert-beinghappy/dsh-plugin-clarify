import { ClarifyService } from './clarify-service.ts'
import { acceptedInferenceEngine, type ClarifyAcceptanceCompose } from './acceptance-channel.ts'
import { detectHostCapabilities, peekHost, type HostLike } from './compat.ts'
import { resolveHostBinding } from './host-binding.ts'
import { registerClarifyHostDiy } from './host-diy.ts'
import { AcceptanceInferenceController } from './inference-controller.ts'
import { clarifyProbeEnabled, registerClarifyProbeRoute, type ProbeContext } from './probe.ts'
import { registerClarifyRemote } from './remote.ts'
import { ClarifyError, type ResolvedHostBinding } from './types.ts'

export const name = 'dsh-plugin-clarify'
export const provide = 'clarify'

/**
 * Cordis 4 object inject is required-deps + intercept config, not
 * `{ required: false }`. Keep the plugin fiber free of unrelated Host
 * services so a tokenMeter/agents flap cannot withdraw typert.register.
 * Remote and DIY each wait on their own child fiber.
 */
export const inject = {}

export const TYPERT_READY_INJECT = ['typert', 'typertGateway'] as const
export const WEB_READY_INJECT = ['webServer'] as const

export interface ClarifyHostContext extends HostLike {
  webServer?: Parameters<typeof registerClarifyHostDiy>[0]
  sessions?: Parameters<typeof resolveHostBinding>[0]
}

export function apply(ctx: ClarifyHostContext): void {
  const inference = new AcceptanceInferenceController()
  const service = new ClarifyService({
    resolveBinding: (sessionId) => resolveBinding(ctx, sessionId),
    inference,
  })
  const acceptanceCompose: ClarifyAcceptanceCompose = (payload) => {
    const engine = acceptedInferenceEngine(payload)
    if (!engine) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'accepted Host inference payload is invalid', 'configuration')
    }
    if (service.runningProcessIds().length > 0) {
      throw new ClarifyError('PROCESS_BUSY', 'cannot compose accepted Host inference while Clarify is running', 'conflict')
    }
    const deactivate = inference.activate(engine)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      try {
        service.cancelAllRunning()
      } finally {
        deactivate()
      }
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject([...WEB_READY_INJECT], (ready) => {
      registerWebSurfaces(ready as ClarifyHostContext)
    })
    ctx.inject([...TYPERT_READY_INJECT], (ready) => {
      registerClarifyRemote(ready, service, acceptanceCompose)
    })
    return
  }

  registerWebSurfaces(ctx)
  registerClarifyRemote(ctx, service, acceptanceCompose)
}

Object.assign(apply, { inject, provide })

function registerWebSurfaces(ctx: ClarifyHostContext): void {
  const webServer = (peekHost(ctx, 'webServer') ?? ctx.webServer) as ClarifyHostContext['webServer']
  if (webServer) {
    registerClarifyHostDiy(webServer)
    if (clarifyProbeEnabled()) registerClarifyProbeRoute(webServer, ctx as ProbeContext)
  }
}

function resolveBinding(ctx: ClarifyHostContext, sessionId: string): ResolvedHostBinding {
  const sessions = (peekHost(ctx, 'sessions') ?? ctx.sessions) as ClarifyHostContext['sessions']
  if (sessions?.get) return resolveHostBinding(sessions, sessionId)
  const capabilities = detectHostCapabilities(ctx)
  throw new ClarifyError(
    'PROCESS_NOT_FOUND',
    capabilities.sessionsGet.status === 'unavailable'
      ? 'public sessions service is not injected; start requires a live sessionId from the Host'
      : `session ${sessionId} is not available through the public sessions service`,
    'protocol',
  )
}

export {
  ClarifyService,
  ClarifyError,
  dispatchClarifyRpc,
  dispatchClarifyRpcBody,
  modelRouteIdFromConfig,
  contextVersionFromModelVisible,
  DEFAULT_TTL_MS,
  CLARIFY_HTML_PATH,
  CLARIFY_REMOTE_NAMESPACE,
  CLARIFY_REMOTE_METHODS,
  CLARIFY_API_CHANNEL,
  CLARIFY_WIRE_PROTOCOL,
  createClarifyRemote,
  unwrapClarifyWire,
} from './public-api.ts'
export { lastClarifyRemoteRegistration } from './remote.ts'
export { clarifyProbeEnabled, CLARIFY_PROBE_PATH } from './probe.ts'

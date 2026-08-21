import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLARIFY_REMOTE_METHODS, CLARIFY_REMOTE_NAMESPACE, peekHost } from './compat.ts'
import { contextVersionFromModelVisible, modelRouteIdFromConfig } from './fingerprints.ts'
import { lastClarifyRemoteRegistration } from './remote.ts'

export const CLARIFY_PROBE_PATH = '/clarify/probe'
export const CLARIFY_PROBE_MARKER = '.clarify-probe'

interface ProbeSession {
  id: string
  events?: unknown[]
  deriveMessages?: () => unknown[]
  requestHeader?: () => unknown
  seq?: unknown
  surface?: { nodes?: unknown[] }
}

export interface ProbeContext {
  llm?: {
    stream?: (options: Record<string, unknown>) => AsyncIterable<unknown>
    registerAdapter?: (providers: string[], adapter: unknown) => unknown
  }
  sessions?: {
    create?: (id?: string, options?: { meta?: { cwd?: string } }) => ProbeSession
    get?: (id: string) => unknown
    list?: () => unknown[]
  }
  webServer?: { register?: unknown; port?: number; host?: string }
  tokenMeter?: { measure?: (session: unknown) => unknown }
  typert?: {
    register?: unknown
    local?: { list?: () => unknown[]; get?: (endpoint: string) => unknown }
  }
  typertGateway?: { invoke?: (request: Record<string, unknown>) => Promise<unknown> }
  remote?: { $mount?: unknown }
  clientModules?: { graph?: () => unknown; clientPath?: (id: string) => string | undefined }
  agents?: unknown
}

export function clarifyProbeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLARIFY_PROBE === '1') return true
  const home = env.DSH_HOME
  if (!home) return false
  try {
    return existsSync(join(home, CLARIFY_PROBE_MARKER))
  } catch {
    return false
  }
}

export function peekService(ctx: object, name: string): { present: boolean; error?: string } {
  const viaGet = peekHost(ctx, name)
  if (viaGet !== undefined) return { present: true }
  try {
    const value = (ctx as Record<string, unknown>)[name]
    return { present: value !== undefined }
  } catch (error) {
    return { present: false, error: errorMessage(error) }
  }
}

export async function collectProbeEvidence(ctx: ProbeContext): Promise<Record<string, unknown>> {
  const serviceNames = [
    'llm', 'sessions', 'webServer', 'tokenMeter', 'typert', 'typertGateway',
    'remote', 'clientModules', 'agents', 'connection', 'credentials',
  ]
  const services: Record<string, { present: boolean; error?: string }> = {}
  for (const name of serviceNames) services[name] = peekService(ctx, name)

  const llm = peekValue(ctx, 'llm') as ProbeContext['llm'] | undefined
  const llmSurface = {
    hasStream: typeof llm?.stream === 'function',
    hasRegisterAdapter: typeof llm?.registerAdapter === 'function',
  }

  let llmHelpers: { isAgentLoopRequest?: (request: unknown) => boolean; markAgentLoopRequest?: (request: unknown) => unknown } | undefined
  let llmHelpersError: string | undefined
  try {
    const specifier = '@deepseek-ai/dsh-llm'
    llmHelpers = await import(specifier) as typeof llmHelpers
  } catch (error) {
    llmHelpersError = errorMessage(error)
  }

  const usage = await runUsageProbe(ctx, llmHelpers)
  const header = await runHeaderProbe(ctx)
  const web = await runWebProbe(ctx)

  return jsonSafe({
    capturedAt: new Date().toISOString(),
    dshHint: process.env.CLARIFY_PROBE_DSH_VERSION ?? 'unspecified',
    services,
    llmSurface,
    llmHelpers: {
      loaded: llmHelpers !== undefined,
      hasIsAgentLoopRequest: typeof llmHelpers?.isAgentLoopRequest === 'function',
      hasMarkAgentLoopRequest: typeof llmHelpers?.markAgentLoopRequest === 'function',
      error: llmHelpersError,
    },
    usage,
    header,
    web,
    notes: [
      'Evidence omits credentials, Profile secrets, and Session message bodies.',
      'contextVersion must not be session.seq; fingerprints hash model-visible system/tools/messages.',
      'Accessing undeclared Cordis services throws; optional chaining does not catch that.',
    ],
  }) as Record<string, unknown>
}

export function registerClarifyProbeRoute(
  webServer: { register: (route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void },
  ctx: ProbeContext,
): void {
  webServer.register({
    kind: 'exact',
    path: CLARIFY_PROBE_PATH,
    handler: async (_req, res) => {
      try {
        const evidence = await collectProbeEvidence(ctx)
        writeJson(res, 200, evidence)
      } catch (error) {
        writeJson(res, 500, { error: errorMessage(error) })
      }
    },
  })
}

async function runUsageProbe(
  ctx: ProbeContext,
  llmHelpers: { isAgentLoopRequest?: (request: unknown) => boolean; markAgentLoopRequest?: (request: unknown) => unknown } | undefined,
): Promise<Record<string, unknown>> {
  try {
    return await runUsageProbeInner(ctx, llmHelpers)
  } catch (error) {
    return { status: 'blocked', reason: errorMessage(error) }
  }
}

async function runUsageProbeInner(
  ctx: ProbeContext,
  llmHelpers: { isAgentLoopRequest?: (request: unknown) => boolean; markAgentLoopRequest?: (request: unknown) => unknown } | undefined,
): Promise<Record<string, unknown>> {
  const llm = peekValue(ctx, 'llm') as ProbeContext['llm'] | undefined
  const sessions = peekValue(ctx, 'sessions') as ProbeContext['sessions'] | undefined
  if (typeof llm?.stream !== 'function') {
    return { status: 'blocked', reason: 'ctx.llm.stream is not a public function on this Host' }
  }
  if (typeof sessions?.create !== 'function') {
    return { status: 'blocked', reason: 'ctx.sessions.create is not a public function on this Host' }
  }

  const adapterId = 'clarify-probe-adapter'
  let adapterError: string | undefined
  try {
    llm.registerAdapter?.([adapterId], {
      providerInfo: (provider: string) => ({ id: provider, name: 'Clarify probe adapter' }),
      providerRetryPolicy() {},
      listModels() {
        return Promise.resolve([])
      },
      resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model })
      },
      async * stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'probe' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'probe' } }
        yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
  } catch (error) {
    adapterError = errorMessage(error)
  }

  const existing = firstExistingSession(sessions)
  const created = existing ? { session: existing, created: false } : { session: createProbeSession(sessions), created: true }
  const session = created.session
  const before = snapshotSession(ctx, session)
  const request = {
    provider: adapterId,
    model: 'clarify-probe-model',
    messages: [],
    tools: undefined,
  }
  const marked = llmHelpers?.isAgentLoopRequest?.(request) === true
  let streamError: string | undefined
  let chunkTypes: string[] = []
  try {
    for await (const chunk of llm.stream(request)) {
      if (chunk && typeof chunk === 'object' && 'type' in chunk) chunkTypes.push(String((chunk as { type: unknown }).type))
    }
  } catch (error) {
    streamError = errorMessage(error)
  }
  const after = snapshotSession(ctx, session)

  return {
    status: streamError === undefined && adapterError === undefined ? 'observed' : 'blocked',
    adapterError,
    streamError,
    requestWasAgentLoop: marked,
    chunkTypes,
    eventsBefore: before.eventCount,
    eventsAfter: after.eventCount,
    eventCountDelta: after.eventCount - before.eventCount,
    derivedMessageCountBefore: before.derivedCount,
    derivedMessageCountAfter: after.derivedCount,
    derivedDelta: after.derivedCount - before.derivedCount,
    surfaceNodeCountBefore: before.surfaceCount,
    surfaceNodeCountAfter: after.surfaceCount,
    usageMeasureBefore: before.usage,
    usageMeasureAfter: after.usage,
    offTranscript: after.derivedCount === before.derivedCount && after.eventCount === before.eventCount,
    probeCreatedSession: created.created,
    sessionSource: created.created ? 'created-by-probe' : 'existing',
    verdictNotes: [
      'Direct ctx.llm.stream was invoked without markAgentLoopRequest and without tools.',
      'If event/derived deltas are zero, the call did not append a transcript surface; usage still requires a Harness usage channel.',
      'A probe-created session is only a P-usage fixture. It does not prove usage attribution on a bound user Session.',
    ],
  }
}

async function runHeaderProbe(ctx: ProbeContext): Promise<Record<string, unknown>> {
  try {
    return runHeaderProbeInner(ctx)
  } catch (error) {
    return { status: 'blocked', reason: errorMessage(error) }
  }
}

function runHeaderProbeInner(ctx: ProbeContext): Record<string, unknown> {
  const sessions = peekValue(ctx, 'sessions') as ProbeContext['sessions'] | undefined
  if (typeof sessions?.create !== 'function') {
    return { status: 'blocked', reason: 'ctx.sessions.create is not a public function on this Host' }
  }
  const session = createProbeSession(sessions)
  const header = session.requestHeader?.()
  const headerRecord = header && typeof header === 'object' ? header as Record<string, unknown> : undefined
  const config = headerRecord?.config && typeof headerRecord.config === 'object'
    ? headerRecord.config as Record<string, unknown>
    : undefined
  const messages = session.deriveMessages?.() ?? []
  return {
    status: headerRecord === undefined ? 'blocked-live-header' : 'observed',
    reason: headerRecord === undefined
      ? 'requestHeader() is undefined on a fresh session; public API has no context revision id besides the forbidden session.seq fallback'
      : undefined,
    hasRequestHeader: headerRecord !== undefined,
    headerKeys: headerRecord ? Object.keys(headerRecord) : [],
    configKeys: config ? Object.keys(config) : [],
    hasSystemField: headerRecord !== undefined && 'system' in headerRecord,
    hasToolsField: headerRecord !== undefined && 'tools' in headerRecord,
    hasProvider: config !== undefined && 'provider' in config,
    hasModel: config !== undefined && 'model' in config,
    hasReasoningEffort: config !== undefined && 'reasoningEffort' in config,
    hasSessionSeq: 'seq' in session,
    fingerprintFromEmptyHeader: {
      contextVersion: contextVersionFromModelVisible({
        system: headerRecord?.system as string | undefined,
        tools: headerRecord?.tools,
        messages,
      }),
      modelRouteId: modelRouteIdFromConfig({
        provider: config?.provider as string | undefined,
        model: config?.model as string | undefined,
        reasoningEffort: config?.reasoningEffort as string | undefined,
      }),
    },
    liveSystemToolsChangeWithoutNewMessages: {
      status: 'blocked',
      reason: 'stock public API was not observed to mutate system/tools without an agent loop or a request/header write; probe refuses to append request/header itself',
    },
  }
}

async function runWebProbe(ctx: ProbeContext): Promise<Record<string, unknown>> {
  try {
    const webServer = peekValue(ctx, 'webServer') as ProbeContext['webServer'] | undefined
    const clientModules = peekValue(ctx, 'clientModules') as ProbeContext['clientModules'] | undefined
    const remote = peekValue(ctx, 'remote') as ProbeContext['remote'] | undefined
    const typert = peekValue(ctx, 'typert') as ProbeContext['typert'] | undefined
    const typertGateway = peekValue(ctx, 'typertGateway') as ProbeContext['typertGateway'] | undefined
    let graphError: string | undefined
    let graph: unknown
    try {
      graph = typeof clientModules?.graph === 'function' ? clientModules.graph() : undefined
    } catch (error) {
      graphError = errorMessage(error)
    }
    const listed = listTypertEndpoints(typert)
    const expectedEndpoints = CLARIFY_REMOTE_METHODS.map((method) => `${CLARIFY_REMOTE_NAMESPACE}/${method}`)
    const claimed = expectedEndpoints
      .every((endpoint) => listed.includes(endpoint))
    const localExact = Object.fromEntries(
      expectedEndpoints.map((endpoint) => {
        try {
          return [endpoint, typert?.local?.get?.(endpoint) !== undefined]
        } catch {
          return [endpoint, false]
        }
      }),
    )
    const live = inspectLiveService(ctx)
    const consumer = await probeClarifyConsumer(typertGateway)
    const registration = lastClarifyRemoteRegistration()
    return {
      hasWebServer: webServer !== undefined,
      hasRegister: typeof webServer?.register === 'function',
      webServerPort: webServer?.port,
      webServerHost: webServer?.host,
      hasClientModules: clientModules !== undefined,
      clientGraphEntryCount: Array.isArray((graph as { entries?: unknown[] } | undefined)?.entries)
        ? (graph as { entries: unknown[] }).entries.length
        : undefined,
      graphError,
      hasRemoteMount: typeof remote?.$mount === 'function',
      remotePeek: peekService(ctx, 'remote'),
      hasTypert: typert !== undefined,
      hasTypertRegister: typeof typert?.register === 'function',
      hasTypertGateway: typertGateway !== undefined,
      hasTypertGatewayInvoke: typeof typertGateway?.invoke === 'function',
      typertLocalEndpoints: listed,
      typertLocalExact: localExact,
      clarifyRemoteClaimed: claimed,
      remoteRegistration: registration ?? null,
      liveService: live,
      consumerPath: consumer,
      hostDiyPaths: ['/clarify', '/clarify/probe'],
      currentSessionDiscovery: {
        status: 'blocked',
        reason: 'stock public API was not observed to expose the current user sessionId; DIY requires the user to paste an existing sessionId and will not create one',
      },
      stockWebPluginUiMount: {
        status: 'unproven',
        reason: 'this probe does not claim a ConversationNode or settings panel; Host DIY GET /clarify is the documented fallback and must use the same /api Remote',
      },
    }
  } catch (error) {
    return { status: 'blocked', reason: errorMessage(error) }
  }
}

function listTypertEndpoints(typert: ProbeContext['typert']): string[] {
  try {
    const listed = typert?.local?.list?.() ?? []
    return listed.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const record = item as { namespace?: unknown; method?: unknown }
      if (typeof record.namespace === 'string' && typeof record.method === 'string') {
        return [`${record.namespace}/${record.method}`]
      }
      return []
    })
  } catch {
    return []
  }
}

async function probeClarifyConsumer(gateway: ProbeContext['typertGateway']): Promise<Record<string, unknown>> {
  if (typeof gateway?.invoke !== 'function') {
    return { status: 'blocked', reason: 'ctx.typertGateway.invoke is not a public function on this Host' }
  }
  const methods = CLARIFY_REMOTE_METHODS
  const endpoints: Record<string, unknown> = {}
  let hits = 0
  for (const method of methods) {
    const args = method === 'start'
      ? { sessionId: 'clarify-probe-missing-session' }
      : { processId: 'clarify-probe-missing-process' }
    try {
      const result = await gateway.invoke({ namespace: CLARIFY_REMOTE_NAMESPACE, method, args })
      const arrival = classifyArrival({
        value: result,
        processId: result && typeof result === 'object' ? (result as { processId?: unknown }).processId : undefined,
      })
      endpoints[method] = {
        status: arrival.kind === 'business' ? 'hit' : 'blocked',
        kind: arrival.kind,
        resultKeys: result && typeof result === 'object' ? Object.keys(result as object) : [],
      }
      if (arrival.kind === 'business') hits += 1
    } catch (error) {
      const message = errorMessage(error)
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined
      const arrival = classifyArrival({ message, code })
      endpoints[method] = {
        status: arrival.kind === 'business' ? 'hit' : 'blocked',
        kind: arrival.kind,
        error: message,
        code,
      }
      if (arrival.kind === 'business') hits += 1
    }
  }
  return {
    status: hits === methods.length ? 'observed' : 'blocked',
    path: 'typertGateway.invoke',
    observed: hits,
    endpoints,
    note: 'only PROCESS_NOT_FOUND / PROCESS_BUSY / SESSION_ID_REQUIRED / INVALID_ANSWER (or a process echo) prove the receiver; invocation-unavailable and HTTP 404 are infrastructure blocks',
  }
}

function classifyArrival(input: { message?: string; code?: string; value?: unknown; processId?: unknown }): {
  kind: 'business' | 'infrastructure' | 'none'
} {
  const message = String(input.message ?? '')
  const code = String(input.code ?? '')
  if (
    code === 'invocation-unavailable'
    || code === 'definition-unavailable'
    || code === 'service-unavailable'
    || /no active Remote method|invocation-unavailable|definition-unavailable|active Service .+ is unavailable|^not found$/i.test(message)
  ) {
    return { kind: 'infrastructure' }
  }
  if (
    code === 'PROCESS_NOT_FOUND'
    || code === 'PROCESS_BUSY'
    || code === 'SESSION_ID_REQUIRED'
    || code === 'INVALID_ANSWER'
    || /PROCESS_NOT_FOUND|PROCESS_BUSY|SESSION_ID_REQUIRED|INVALID_ANSWER|process .+ does not exist|sessionId is required|session .+ is not available|already inferring/i.test(message)
    || typeof input.processId === 'string'
  ) {
    return { kind: 'business' }
  }
  if (input.value && typeof input.value === 'object' && typeof (input.value as { processId?: unknown }).processId === 'string') {
    return { kind: 'business' }
  }
  return { kind: 'none' }
}

function inspectLiveService(ctx: ProbeContext): Record<string, unknown> {
  const provided = peekValue(ctx, 'clarify')
  return {
    reflected: provided !== undefined,
    hasStart: typeof (provided as { start?: unknown } | undefined)?.start === 'function',
    hasAnswer: typeof (provided as { answer?: unknown } | undefined)?.answer === 'function',
    hasCancel: typeof (provided as { cancel?: unknown } | undefined)?.cancel === 'function',
    hasFetchDraft: typeof (provided as { fetchDraft?: unknown } | undefined)?.fetchDraft === 'function',
    note: 'Client $mount TypertRemoteContribution is not used; Host receiver must be the provide/reflect live Service',
  }
}

function firstExistingSession(sessions: NonNullable<ProbeContext['sessions']>): ProbeSession | undefined {
  try {
    const listed = sessions.list?.()
    if (!Array.isArray(listed) || listed.length === 0) return undefined
    const first = listed[0]
    if (first && typeof first === 'object' && typeof (first as ProbeSession).id === 'string') {
      const live = typeof sessions.get === 'function' ? sessions.get((first as ProbeSession).id) : first
      return live && typeof live === 'object' ? live as ProbeSession : first as ProbeSession
    }
    return undefined
  } catch {
    return undefined
  }
}

function createProbeSession(sessions: NonNullable<ProbeContext['sessions']>): ProbeSession {
  if (typeof sessions.create !== 'function') {
    throw new Error('ctx.sessions.create is not a public function on this Host')
  }
  try {
    return sessions.create()
  } catch (first) {
    const cwd = process.env.DSH_HOME && process.env.DSH_HOME.startsWith('/')
      ? process.env.DSH_HOME
      : tmpdir()
    try {
      return sessions.create(undefined, { meta: { cwd } })
    } catch (second) {
      throw new Error(`sessions.create failed: ${errorMessage(first)}; retry with cwd: ${errorMessage(second)}`)
    }
  }
}

function snapshotSession(ctx: ProbeContext, session: {
  events?: unknown[]
  deriveMessages?: () => unknown[]
  surface?: { nodes?: unknown[] }
}): { eventCount: number; derivedCount: number; surfaceCount: number; usage: unknown } {
  let usage: unknown
  try {
    const tokenMeter = peekValue(ctx, 'tokenMeter') as ProbeContext['tokenMeter'] | undefined
    usage = tokenMeter?.measure?.(session)
    if (usage && typeof usage === 'object') usage = summarizeUsage(usage as Record<string, unknown>)
  } catch (error) {
    usage = { error: errorMessage(error) }
  }
  return {
    eventCount: Array.isArray(session.events) ? session.events.length : -1,
    derivedCount: Array.isArray(session.deriveMessages?.()) ? session.deriveMessages()!.length : -1,
    surfaceCount: Array.isArray(session.surface?.nodes) ? session.surface!.nodes!.length : -1,
    usage,
  }
}

function summarizeUsage(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== null && typeof nested === 'object') out[key] = Object.keys(nested as object)
    else if (typeof nested === 'number' || typeof nested === 'boolean' || nested === undefined) out[key] = nested
    else out[key] = typeof nested
  }
  return out
}

function peekValue(ctx: object, name: string): unknown {
  return peekHost(ctx, name)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(jsonSafe(body))
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  }
  res.end(payload)
}

export function jsonSafe(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (inner: unknown): unknown => {
    if (inner === null || typeof inner === 'boolean' || typeof inner === 'string') return inner
    if (typeof inner === 'number') return Number.isFinite(inner) ? inner : String(inner)
    if (typeof inner === 'bigint') return inner.toString()
    if (typeof inner === 'undefined') return null
    if (typeof inner !== 'object') return String(inner)
    if (seen.has(inner)) return '[Circular]'
    seen.add(inner)
    if (Array.isArray(inner)) return inner.map(walk)
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(inner as Record<string, unknown>)) {
      try {
        out[key] = walk(nested)
      } catch (error) {
        out[key] = { error: errorMessage(error) }
      }
    }
    return out
  }
  return walk(value)
}

export function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

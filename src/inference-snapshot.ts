import { contextVersionFromModelVisible, modelRouteIdFromConfig } from './fingerprints.ts'
import { ClarifyError, type InferenceCallConfig, type InferenceSnapshot } from './types.ts'

export interface SnapshotSession {
  requestHeader?: () => {
    config?: Record<string, unknown>
    system?: unknown
    tools?: unknown
  } | undefined
  requestContext?: () => unknown
  deriveMessages?: () => unknown
}

export interface DefaultModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export function captureInferenceSnapshot(
  sessionId: string,
  session: SnapshotSession,
  capturedAt = Date.now(),
  readDefaultModel?: () => DefaultModelSelection | undefined,
): InferenceSnapshot {
  const header = callHostSurface(() => session.requestHeader?.(), 'session requestHeader() failed')
  if (header !== undefined && !isRecord(header)) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'session requestHeader() returned an invalid value', 'configuration')
  }
  const derived = cloneModelData(callHostSurface(
    () => session.deriveMessages?.(),
    'session deriveMessages() failed',
  ))
  if (!Array.isArray(derived)) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'session deriveMessages() did not return an array', 'configuration')
  }
  const requestContextValue = cloneModelData(callHostSurface(
    () => session.requestContext?.(),
    'session requestContext() failed',
  ))
  const requestContext = isRecord(requestContextValue) ? requestContextValue : undefined
  const config = (header === undefined
    ? emptySessionDefault(derived, requestContext, readDefaultModel)
    : header.config) as Readonly<Record<string, unknown>> | undefined
  const provider = requiredRouteText(config?.provider, 'provider')
  const model = requiredRouteText(config?.model, 'model')
  const callConfig: InferenceCallConfig = {
    provider,
    model,
    ...optionalText(config?.reasoningEffort, 'reasoningEffort'),
    ...optionalFiniteNumber(config?.temperature, 'temperature'),
    ...optionalFiniteNumber(config?.maxTokens, 'maxTokens'),
    ...optionalStringList(config?.stop, 'stop'),
  }
  const system = typeof header?.system === 'string' ? header.system : undefined
  const tools = cloneModelData(header?.tools)
  if (
    requestContext !== undefined
    && (requestContext.provider !== provider || requestContext.model !== model)
  ) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'session requestContext route does not match requestHeader config', 'configuration')
  }
  const contextVersion = contextVersionFromModelVisible({ system, tools, messages: derived })
  const modelRouteId = modelRouteIdFromConfig(callConfig)

  return deepFreeze({
    sessionId,
    capturedAt,
    ...system === undefined ? {} : { system },
    ...tools === undefined ? {} : { tools },
    derivedMessages: derived,
    ...requestContext === undefined ? {} : { requestContext },
    callConfig,
    contextVersion,
    modelRouteId,
  })
}

function emptySessionDefault(
  derived: readonly unknown[],
  requestContext: Readonly<Record<string, unknown>> | undefined,
  readDefaultModel: (() => DefaultModelSelection | undefined) | undefined,
): DefaultModelSelection | undefined {
  if (derived.length > 0 || requestContext !== undefined) {
    throw new ClarifyError(
      'INFERENCE_UNAVAILABLE',
      'Session history exists without a request header; refusing to substitute the current default model',
      'configuration',
    )
  }
  const selection = callHostSurface(() => readDefaultModel?.(), 'agent default model selection failed')
  if (selection === undefined) {
    throw new ClarifyError(
      'INFERENCE_UNAVAILABLE',
      'empty Session requires the public agentDefaultModel selection',
      'configuration',
    )
  }
  return selection
}

export function snapshotHashesMatch(snapshot: InferenceSnapshot): boolean {
  return snapshot.contextVersion === contextVersionFromModelVisible({
    system: snapshot.system,
    tools: snapshot.tools,
    messages: snapshot.derivedMessages,
  }) && snapshot.modelRouteId === modelRouteIdFromConfig(snapshot.callConfig)
}

function requiredRouteText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', `session requestHeader() is missing model route ${field}`, 'configuration')
  }
  return value
}

function optionalText(value: unknown, field: 'reasoningEffort'): Partial<InferenceCallConfig> {
  if (value === undefined) return {}
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', `session model route ${field} is invalid`, 'configuration')
  }
  return { [field]: value }
}

function optionalFiniteNumber(value: unknown, field: 'temperature' | 'maxTokens'): Partial<InferenceCallConfig> {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', `session model route ${field} is invalid`, 'configuration')
  }
  return { [field]: value }
}

function optionalStringList(value: unknown, field: 'stop'): Partial<InferenceCallConfig> {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', `session model route ${field} is invalid`, 'configuration')
  }
  return { [field]: [...value] }
}

function callHostSurface<T>(call: () => T, message: string): T | undefined {
  try {
    return call()
  } catch {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', message, 'configuration')
  }
}

function cloneModelData<T>(value: T): T {
  if (value === undefined) return value
  try {
    return structuredClone(value)
  } catch {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'session model-visible context is not safely cloneable', 'configuration')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  return Object.freeze(value)
}

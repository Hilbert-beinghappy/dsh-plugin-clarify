export const PROCESS_STATUSES = ['running', 'cancelled', 'stale', 'complete'] as const
export type ProcessStatus = (typeof PROCESS_STATUSES)[number]

export const STALE_REASONS = [
  'session-changed',
  'route-changed',
  'context-changed',
  'new-official-message',
  'compaction',
  'recall-injection',
  'ttl-expired',
] as const
export type StaleReason = (typeof STALE_REASONS)[number]

export interface ClarifyOption {
  optionId: string
  text: string
}

export interface ClarifyQuestion {
  questionId: string
  text: string
  options: ClarifyOption[]
  multiple: boolean
  allowCustom: boolean
}

export interface ProcessEcho {
  processId: string
  sessionId: string
  status: ProcessStatus
  contextVersion: string
  modelRouteId: string
  staleReason?: StaleReason
  previewVersion?: string
}

export interface StartRequest {
  sessionId: string
  seedText?: string
}

export interface StartResponse extends ProcessEcho {
  kind?: ModelInference['kind']
  question?: ClarifyQuestion
  draftPreview?: string
  materialChanges?: string[]
}

export interface AnswerRequest {
  processId: string
  questionId: string
  previewVersion: string
  selectedOptionIds?: string[]
  customText?: string
}

export interface AnswerResponse extends ProcessEcho {
  kind?: ModelInference['kind']
  question?: ClarifyQuestion
  draftPreview?: string
  materialChanges?: string[]
}

export interface AcceptRequest {
  processId: string
  previewVersion: string
}

export type AcceptResponse = ProcessEcho

export interface CancelRequest {
  processId: string
}

export type CancelResponse = ProcessEcho

export interface FetchDraftRequest {
  processId: string
}

export interface FetchDraftResponse extends StartResponse {
  draft?: string
}

export interface RefineRequest {
  processId: string
  previewVersion: string
  feedback: string
}

export interface RefineResponse extends ProcessEcho {
  kind?: ModelInference['kind']
  question?: ClarifyQuestion
  draftPreview?: string
  materialChanges?: string[]
}

export interface HostBinding {
  sessionId: string
  contextVersion: string
  modelRouteId: string
}

/** Host-internal binding preimage. This is not part of any Remote response. */
export interface ResolvedHostBinding extends HostBinding {
  snapshot?: InferenceSnapshot
}

export interface BindingResolver {
  resolve(sessionId: string): ResolvedHostBinding
}

export interface Clock {
  now(): number
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000

export const CLARIFY_WIRE_PROTOCOL = 'clarify.wire/1' as const
export type ClarifyWireProtocol = typeof CLARIFY_WIRE_PROTOCOL

export type ClarifyErrorCode =
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_BUSY'
  | 'INVALID_ANSWER'
  | 'SESSION_ID_REQUIRED'
  | 'PREVIEW_OUTDATED'
  | 'INFERENCE_UNAVAILABLE'

export type ClarifyFailureCategory =
  | 'retryable'
  | 'configuration'
  | 'conflict'
  | 'invalid-request'
  | 'protocol'

export interface ClarifyWireError {
  readonly code: ClarifyErrorCode
  readonly message: string
  readonly category: ClarifyFailureCategory
}

export type ClarifyWireResult<T> =
  | { readonly protocol: typeof CLARIFY_WIRE_PROTOCOL; readonly ok: true; readonly value: T }
  | { readonly protocol: typeof CLARIFY_WIRE_PROTOCOL; readonly ok: false; readonly error: ClarifyWireError }

export class ClarifyError extends Error {
  readonly code: ClarifyErrorCode
  readonly category: ClarifyFailureCategory

  constructor(code: ClarifyErrorCode, message: string, category: ClarifyFailureCategory) {
    super(message)
    this.name = 'ClarifyError'
    this.code = code
    this.category = category
  }
}

export function clarifyWireOk<T>(value: T): ClarifyWireResult<T> {
  return { protocol: CLARIFY_WIRE_PROTOCOL, ok: true, value }
}

export function clarifyWireErr(error: ClarifyError): ClarifyWireResult<never> {
  return {
    protocol: CLARIFY_WIRE_PROTOCOL,
    ok: false,
    error: { code: error.code, message: error.message, category: error.category },
  }
}

export function unwrapClarifyWire<T>(result: ClarifyWireResult<T>): T {
  if (result.ok) return result.value
  throw new ClarifyError(result.error.code, result.error.message, result.error.category)
}

export function isCarrierCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const code = 'code' in error ? String((error as { code?: unknown }).code) : ''
  return name === 'AbortError'
    || name === 'RemoteInvocationCancelled'
    || code === 'ABORT_ERR'
    || code === 'cancelled'
}

export async function asClarifyWireResult<T>(work: () => Promise<T>): Promise<ClarifyWireResult<T>> {
  try {
    return clarifyWireOk(await work())
  } catch (error) {
    if (isCarrierCancellation(error)) throw error
    if (error instanceof ClarifyError) return clarifyWireErr(error)
    throw error
  }
}

export interface ModelAsk {
  kind: 'ask'
  question: string
  options: string[]
  multiple: boolean
  allowCustom: boolean
  draftPreview: string
  materialChanges: string[]
}

export interface ModelAwaitAccept {
  kind: 'await_accept'
  draftPreview: string
  materialChanges: string[]
}

export type ModelInference = ModelAsk | ModelAwaitAccept

export type AcceptedDecision =
  | {
      questionText: string
      answer: 'selected_options'
      selectedOptionTexts: readonly [string, ...string[]]
    }
  | {
      questionText: string
      answer: 'custom'
      customText: string
    }

export interface PriorPublishedDraft {
  draftPreview: string
  materialChanges: string[]
}

export interface InferenceCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
}

export interface InferenceSnapshot {
  sessionId: string
  capturedAt: number
  system?: string
  tools?: unknown
  derivedMessages: readonly unknown[]
  requestContext?: Readonly<Record<string, unknown>>
  callConfig: Readonly<InferenceCallConfig>
  contextVersion: string
  modelRouteId: string
}

export interface InferenceInput {
  sessionId: string
  seedText?: string
  acceptedDecisions: readonly AcceptedDecision[]
  priorPublishedDraft?: PriorPublishedDraft
  refineFeedback?: string
  snapshot?: InferenceSnapshot
}

export interface InferenceRepairInput extends InferenceInput {
  routeId: string
  raw: string
  reason: string
}

export type InferenceResult = ModelInference

export interface InferenceEngine {
  infer(input: InferenceInput, signal: AbortSignal): Promise<ModelInference | string>
  repair?(input: InferenceRepairInput, signal: AbortSignal): Promise<string>
}

export class UnauthorizedInferenceEngine implements InferenceEngine {
  async infer(): Promise<never> {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'real inference engine is not authorized', 'configuration')
  }
}

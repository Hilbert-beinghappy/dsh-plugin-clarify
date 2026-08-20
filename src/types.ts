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
}

export interface StartRequest {
  sessionId: string
  seedText?: string
}

export interface StartResponse extends ProcessEcho {
  question?: ClarifyQuestion
}

export interface AnswerRequest {
  processId: string
  questionId: string
  selectedOptionIds?: string[]
  customText?: string
}

export interface AnswerResponse extends ProcessEcho {
  question?: ClarifyQuestion
}

export interface CancelRequest {
  processId: string
}

export type CancelResponse = ProcessEcho

export interface FetchDraftRequest {
  processId: string
}

export interface FetchDraftResponse extends ProcessEcho {
  draft?: string
}

export interface HostBinding {
  sessionId: string
  contextVersion: string
  modelRouteId: string
}

export interface BindingResolver {
  resolve(sessionId: string): HostBinding
}

export interface Clock {
  now(): number
}

export const DEFAULT_TTL_MS = 15 * 60 * 1000

export type ClarifyErrorCode =
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_BUSY'
  | 'INVALID_ANSWER'
  | 'SESSION_ID_REQUIRED'

export class ClarifyError extends Error {
  readonly code: ClarifyErrorCode

  constructor(code: ClarifyErrorCode, message: string) {
    super(message)
    this.name = 'ClarifyError'
    this.code = code
  }
}

export interface AnswerRecord {
  questionId: string
  selectedOptionIds?: string[]
  customText?: string
}

export interface InferenceInput {
  sessionId: string
  seedText?: string
  history: readonly AnswerRecord[]
  currentQuestion?: ClarifyQuestion
}

export type InferenceResult =
  | { kind: 'question'; question: ClarifyQuestion }
  | { kind: 'draft'; draft: string }

export interface InferenceEngine {
  infer(input: InferenceInput, signal: AbortSignal): Promise<InferenceResult>
}

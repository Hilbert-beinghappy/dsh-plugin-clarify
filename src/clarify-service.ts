import { randomUUID } from 'node:crypto'
import { StubInferenceEngine } from './stub-inference.ts'
import {
  ClarifyError,
  DEFAULT_TTL_MS,
  type AnswerRequest,
  type AnswerResponse,
  type BindingResolver,
  type CancelRequest,
  type CancelResponse,
  type ClarifyQuestion,
  type FetchDraftRequest,
  type FetchDraftResponse,
  type HostBinding,
  type InferenceEngine,
  type InferenceResult,
  type ProcessEcho,
  type ProcessStatus,
  type StaleReason,
  type StartRequest,
  type StartResponse,
} from './types.ts'

export interface ClarifyServiceOptions {
  resolveBinding: BindingResolver['resolve']
  now?: () => number
  ttlMs?: number
  inference?: InferenceEngine
  onCancelInFlight?: (processId: string) => void
  idFactory?: () => string
}

interface ProcessRecord {
  processId: string
  sessionId: string
  contextVersion: string
  modelRouteId: string
  status: ProcessStatus
  staleReason?: StaleReason
  question?: ClarifyQuestion
  draft?: string
  seedText?: string
  history: Array<{ questionId: string; selectedOptionIds?: string[]; customText?: string }>
  lastActivity: number
  abort: AbortController
  inFlight: boolean
}

export class ClarifyService {
  private readonly processes = new Map<string, ProcessRecord>()
  private readonly runningBySession = new Map<string, string>()
  private readonly resolveBinding: BindingResolver['resolve']
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly inference: InferenceEngine
  private readonly onCancelInFlight?: (processId: string) => void
  private readonly idFactory: () => string

  constructor(options: ClarifyServiceOptions) {
    this.resolveBinding = options.resolveBinding
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.inference = options.inference ?? new StubInferenceEngine()
    this.onCancelInFlight = options.onCancelInFlight
    this.idFactory = options.idFactory ?? (() => randomUUID())
  }

  runningProcessIds(): string[] {
    this.sweep()
    return [...this.processes.values()].filter((record) => record.status === 'running').map((record) => record.processId)
  }

  async start(request: StartRequest): Promise<StartResponse> {
    this.sweep()
    const sessionId = request.sessionId?.trim() ?? ''
    if (!sessionId) throw new ClarifyError('SESSION_ID_REQUIRED', 'sessionId is required')
    const binding = this.resolveBinding(sessionId)
    const previousId = this.runningBySession.get(sessionId)
    if (previousId) this.finalizeCancel(this.mustGet(previousId))

    const processId = this.idFactory()
    const abort = new AbortController()
    const record: ProcessRecord = {
      processId,
      sessionId: binding.sessionId,
      contextVersion: binding.contextVersion,
      modelRouteId: binding.modelRouteId,
      status: 'running',
      seedText: request.seedText,
      history: [],
      lastActivity: this.now(),
      abort,
      inFlight: true,
    }
    this.processes.set(processId, record)
    this.runningBySession.set(sessionId, processId)

    try {
      const result = await this.inference.infer({
        sessionId,
        seedText: request.seedText,
        history: [],
      }, abort.signal)
      if (record.status !== 'running') return this.startEcho(record)
      const stale = this.staleFromBinding(record)
      if (stale) return this.startEcho(stale)
      this.touch(record)
      if (result.kind === 'question') {
        record.question = assertClarifyQuestion(result.question)
        return this.startEcho(record)
      }
      record.status = 'complete'
      record.draft = assertDraft(result)
      record.question = undefined
      this.runningBySession.delete(sessionId)
      return this.startEcho(record)
    } catch (error) {
      if (abort.signal.aborted || record.status !== 'running') return this.startEcho(record)
      this.discardUnreachable(record)
      throw error
    } finally {
      record.inFlight = false
    }
  }

  async answer(request: AnswerRequest): Promise<AnswerResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status !== 'running') return this.echo(record)
    const stale = this.staleFromBinding(record)
    if (stale) return this.echo(stale)
    if (record.inFlight) {
      throw new ClarifyError('PROCESS_BUSY', 'process is already inferring')
    }
    record.inFlight = true
    try {
      const nextHistory = this.prepareUserAnswer(record, request)
      const inferred = await this.runAnswerInference(record, nextHistory)
      if (inferred.kind === 'terminal') return inferred.echo
      return this.commitAnswerOutput(record, nextHistory, inferred.result)
    } finally {
      record.inFlight = false
    }
  }

  async cancel(request: CancelRequest): Promise<CancelResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status === 'running') this.finalizeCancel(record)
    return this.echo(record)
  }

  async fetchDraft(request: FetchDraftRequest): Promise<FetchDraftResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status === 'running') {
      const stale = this.staleFromBinding(record)
      if (stale) return this.echo(stale)
      return this.echo(record)
    }
    if (record.status === 'complete') {
      const stale = this.staleFromBinding(record)
      if (stale) return this.echo(stale)
      const draft = record.draft
      this.processes.delete(record.processId)
      return { ...this.echo(record), draft }
    }
    return this.echo(record)
  }

  markStale(processId: string, reason: StaleReason): ProcessEcho {
    this.sweep()
    const record = this.mustGet(processId)
    if (record.status === 'running' || record.status === 'complete') {
      this.applyStale(record, reason)
    }
    return this.echo(record)
  }

  private prepareUserAnswer(record: ProcessRecord, request: AnswerRequest): ProcessRecord['history'] {
    this.validateAnswer(record, request)
    const answerEntry = {
      questionId: request.questionId,
      ...request.selectedOptionIds === undefined ? {} : { selectedOptionIds: [...request.selectedOptionIds] },
      ...request.customText === undefined ? {} : { customText: request.customText },
    }
    this.touch(record)
    return cloneHistory([...record.history, answerEntry])
  }

  private async runAnswerInference(
    record: ProcessRecord,
    nextHistory: ProcessRecord['history'],
  ): Promise<{ kind: 'terminal'; echo: AnswerResponse } | { kind: 'result'; result: InferenceResult }> {
    let result: InferenceResult
    try {
      result = await this.inference.infer({
        sessionId: record.sessionId,
        seedText: record.seedText,
        history: cloneHistory(nextHistory),
        currentQuestion: cloneQuestion(record.question),
      }, record.abort.signal)
    } catch (error) {
      if (record.abort.signal.aborted || record.status !== 'running') {
        return { kind: 'terminal', echo: this.echo(record) }
      }
      throw error
    }
    if (record.status !== 'running') return { kind: 'terminal', echo: this.echo(record) }
    const after = this.staleFromBinding(record)
    if (after) return { kind: 'terminal', echo: this.echo(after) }
    return { kind: 'result', result }
  }

  private commitAnswerOutput(
    record: ProcessRecord,
    nextHistory: ProcessRecord['history'],
    result: InferenceResult,
  ): AnswerResponse {
    try {
      if (result.kind === 'question') {
        record.history = nextHistory
        record.question = assertClarifyQuestion(result.question)
        this.touch(record)
        return this.respondWithQuestion(record)
      }
      const draft = assertDraft(result)
      record.history = nextHistory
      record.status = 'complete'
      record.draft = draft
      record.question = undefined
      this.runningBySession.delete(record.sessionId)
      this.touch(record)
      return this.echo(record)
    } catch (error) {
      if (error instanceof ClarifyError && error.code === 'INVALID_ANSWER') {
        this.finalizeCancel(record)
      }
      throw error
    }
  }

  private validateAnswer(record: ProcessRecord, request: AnswerRequest): void {
    const question = record.question
    if (!question || question.questionId !== request.questionId) {
      throw new ClarifyError('INVALID_ANSWER', 'questionId does not match the current question')
    }
    const hasOptions = request.selectedOptionIds !== undefined
    const hasCustom = request.customText !== undefined
    if (hasOptions === hasCustom) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds and customText are mutually exclusive and required as one of the two')
    }
    if (hasCustom) {
      if (!question.allowCustom) {
        throw new ClarifyError('INVALID_ANSWER', 'customText is only valid when allowCustom is true')
      }
      if (request.customText!.trim() === '') {
        throw new ClarifyError('INVALID_ANSWER', 'customText must not be empty')
      }
      return
    }
    const selected = request.selectedOptionIds ?? []
    if (selected.length === 0) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must not be empty')
    }
    if (new Set(selected).size !== selected.length) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must not contain duplicates')
    }
    if (selected.some((optionId) => typeof optionId !== 'string' || optionId.trim() === '')) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must contain non-empty optionId values')
    }
    if (!question.multiple && selected.length !== 1) {
      throw new ClarifyError('INVALID_ANSWER', 'multiple=false requires exactly one selectedOptionId')
    }
    if (question.multiple && selected.length < 1) {
      throw new ClarifyError('INVALID_ANSWER', 'multiple=true requires at least one selectedOptionId')
    }
    const allowed = new Set(question.options.map((option) => option.optionId))
    for (const optionId of selected) {
      if (!allowed.has(optionId)) {
        throw new ClarifyError('INVALID_ANSWER', `unknown optionId ${optionId}`)
      }
    }
  }

  private staleFromBinding(record: ProcessRecord): ProcessRecord | undefined {
    try {
      const binding = this.resolveBinding(record.sessionId)
      if (binding.modelRouteId !== record.modelRouteId) return this.applyStale(record, 'route-changed')
      if (binding.contextVersion !== record.contextVersion) return this.applyStale(record, 'context-changed')
      if (binding.sessionId !== record.sessionId) return this.applyStale(record, 'session-changed')
      return undefined
    } catch {
      return this.applyStale(record, 'session-changed')
    }
  }

  private applyStale(record: ProcessRecord, reason: StaleReason): ProcessRecord {
    if (record.status === 'stale' || record.status === 'cancelled') return record
    if (record.status === 'running') {
      record.abort.abort()
      this.onCancelInFlight?.(record.processId)
      this.runningBySession.delete(record.sessionId)
    }
    record.status = 'stale'
    record.staleReason = reason
    record.question = undefined
    record.draft = undefined
    record.inFlight = false
    this.touch(record)
    return record
  }

  private finalizeCancel(record: ProcessRecord): void {
    if (record.status !== 'running') return
    record.abort.abort()
    this.onCancelInFlight?.(record.processId)
    record.status = 'cancelled'
    record.question = undefined
    record.draft = undefined
    record.inFlight = false
    this.runningBySession.delete(record.sessionId)
    this.touch(record)
  }

  private discardUnreachable(record: ProcessRecord): void {
    if (record.status === 'running') {
      record.abort.abort()
      this.onCancelInFlight?.(record.processId)
    }
    if (this.runningBySession.get(record.sessionId) === record.processId) {
      this.runningBySession.delete(record.sessionId)
    }
    record.inFlight = false
    this.processes.delete(record.processId)
  }

  private sweep(): void {
    const now = this.now()
    for (const record of this.processes.values()) {
      if (now - record.lastActivity < this.ttlMs) continue
      if (record.status === 'running' || record.status === 'complete') {
        this.applyStale(record, 'ttl-expired')
      } else if (now - record.lastActivity >= this.ttlMs) {
        this.processes.delete(record.processId)
      }
    }
  }

  private touch(record: ProcessRecord): void {
    record.lastActivity = this.now()
  }

  private mustGet(processId: string): ProcessRecord {
    const record = this.processes.get(processId)
    if (!record) throw new ClarifyError('PROCESS_NOT_FOUND', `process ${processId} does not exist`)
    return record
  }

  private echo(record: ProcessRecord): ProcessEcho {
    return {
      processId: record.processId,
      sessionId: record.sessionId,
      status: record.status,
      contextVersion: record.contextVersion,
      modelRouteId: record.modelRouteId,
      ...record.staleReason === undefined ? {} : { staleReason: record.staleReason },
    }
  }

  private startEcho(record: ProcessRecord): StartResponse {
    return this.respondWithQuestion(record)
  }

  private respondWithQuestion(record: ProcessRecord): StartResponse {
    const question = cloneQuestion(record.question)
    return question === undefined
      ? this.echo(record)
      : { ...this.echo(record), question }
  }
}

export function assertClarifyQuestion(value: unknown): ClarifyQuestion {
  if (!value || typeof value !== 'object') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question must be an object')
  }
  const question = value as ClarifyQuestion
  if (typeof question.questionId !== 'string' || question.questionId.trim() === '') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.questionId must be a non-empty string')
  }
  if (typeof question.text !== 'string' || question.text.trim() === '') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.text must be a non-empty string')
  }
  if (typeof question.multiple !== 'boolean' || typeof question.allowCustom !== 'boolean') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.multiple and allowCustom must be booleans')
  }
  if (!Array.isArray(question.options) || question.options.length === 0) {
    throw new ClarifyError('INVALID_ANSWER', 'inference question must include at least one option')
  }
  const ids = question.options.map((option) => option?.optionId)
  if (ids.some((optionId) => typeof optionId !== 'string' || optionId.trim() === '')) {
    throw new ClarifyError('INVALID_ANSWER', 'inference optionId values must be unique and non-empty')
  }
  if (new Set(ids).size !== ids.length) {
    throw new ClarifyError('INVALID_ANSWER', 'inference optionId values must be unique and non-empty')
  }
  if (question.options.some((option) => typeof option.text !== 'string' || option.text.trim() === '')) {
    throw new ClarifyError('INVALID_ANSWER', 'inference option text must be a non-empty string')
  }
  if (!question.multiple && question.options.length < 1) {
    throw new ClarifyError('INVALID_ANSWER', 'multiple=false requires at least one option')
  }
  if (question.multiple && question.options.length < 1) {
    throw new ClarifyError('INVALID_ANSWER', 'multiple=true requires at least one option')
  }
  return cloneQuestion(question)!
}

function cloneHistory(
  history: ProcessRecord['history'],
): ProcessRecord['history'] {
  return history.map((item) => ({
    questionId: item.questionId,
    ...item.selectedOptionIds === undefined ? {} : { selectedOptionIds: [...item.selectedOptionIds] },
    ...item.customText === undefined ? {} : { customText: item.customText },
  }))
}

function cloneQuestion(question: ClarifyQuestion | undefined): ClarifyQuestion | undefined {
  if (!question) return undefined
  return {
    questionId: question.questionId,
    text: question.text,
    multiple: question.multiple,
    allowCustom: question.allowCustom,
    options: question.options.map((option) => ({ optionId: option.optionId, text: option.text })),
  }
}

function assertDraft(result: { kind: string; draft?: string }): string {
  if (result.kind !== 'draft' || typeof result.draft !== 'string') {
    throw new ClarifyError('INVALID_ANSWER', 'inference result is not a question or draft')
  }
  return result.draft
}

export type { HostBinding }

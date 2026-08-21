import { randomUUID } from 'node:crypto'
import { applyModelInference, isMaterialPreviewChange, toClarifyError } from './model-protocol.ts'
import {
  ClarifyError,
  isCarrierCancellation,
  DEFAULT_TTL_MS,
  UnauthorizedInferenceEngine,
  type AcceptRequest,
  type AcceptResponse,
  type AnswerRequest,
  type AnswerResponse,
  type BindingResolver,
  type CancelRequest,
  type CancelResponse,
  type ClarifyQuestion,
  type FetchDraftRequest,
  type FetchDraftResponse,
  type HostBinding,
  type AcceptedDecision,
  type InferenceEngine,
  type InferenceInput,
  type InferenceSnapshot,
  type ModelAsk,
  type ModelInference,
  type PriorPublishedDraft,
  type ProcessEcho,
  type ProcessStatus,
  type RefineRequest,
  type RefineResponse,
  type ResolvedHostBinding,
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
  opaqueIdFactory?: () => string
}

interface ProcessRecord {
  processId: string
  sessionId: string
  contextVersion: string
  modelRouteId: string
  snapshot?: InferenceSnapshot
  status: ProcessStatus
  staleReason?: StaleReason
  question?: ClarifyQuestion
  draft?: string
  draftPreview?: string
  previewVersion?: string
  materialChanges?: string[]
  seedText?: string
  acceptedDecisions: AcceptedDecision[]
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
  private readonly opaqueIdFactory: () => string

  constructor(options: ClarifyServiceOptions) {
    this.resolveBinding = options.resolveBinding
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.inference = options.inference ?? new UnauthorizedInferenceEngine()
    this.onCancelInFlight = options.onCancelInFlight
    this.idFactory = options.idFactory ?? (() => randomUUID())
    this.opaqueIdFactory = options.opaqueIdFactory ?? (() => randomUUID())
  }

  runningProcessIds(): string[] {
    this.sweep()
    return [...this.processes.values()].filter((record) => record.status === 'running').map((record) => record.processId)
  }

  cancelAllRunning(): void {
    this.sweep()
    for (const record of this.processes.values()) {
      if (record.status !== 'running') continue
      try {
        this.finalizeCancel(record)
      } catch {
        // Bulk teardown must continue aborting every process even if an
        // observer callback fails. finalizeCancel commits state in finally.
      }
    }
  }

  async start(request: StartRequest): Promise<StartResponse> {
    this.sweep()
    const sessionId = request.sessionId?.trim() ?? ''
    if (!sessionId) throw new ClarifyError('SESSION_ID_REQUIRED', 'sessionId is required', 'protocol')
    const binding = this.resolveStartBinding(sessionId)
    const previousId = this.runningBySession.get(sessionId)
    if (previousId) this.finalizeCancel(this.mustGet(previousId))

    const processId = this.idFactory()
    const abort = new AbortController()
    const record: ProcessRecord = {
      processId,
      sessionId: binding.sessionId,
      contextVersion: binding.contextVersion,
      modelRouteId: binding.modelRouteId,
      ...binding.snapshot === undefined ? {} : { snapshot: binding.snapshot },
      status: 'running',
      seedText: request.seedText,
      acceptedDecisions: [],
      lastActivity: this.now(),
      abort,
      inFlight: true,
    }
    this.processes.set(processId, record)
    this.runningBySession.set(sessionId, processId)

    try {
      const input = this.inferenceInput(record, record.acceptedDecisions)
      const result = await this.inference.infer(input, abort.signal)
      if (record.status !== 'running') return this.startEcho(record)
      const stale = this.staleFromBinding(record)
      if (stale) return this.startEcho(stale)
      const model = await this.resolveModelOutput(record, input, result)
      if (!model || record.status !== 'running') return this.startEcho(record)
      this.publishModelOutput(record, model)
      this.touch(record)
      return this.startEcho(record)
    } catch (error) {
      if (isCarrierCancellation(error) && !abort.signal.aborted) throw error
      if (abort.signal.aborted || record.status !== 'running') return this.startEcho(record)
      this.discardUnreachable(record)
      throw this.asServiceError(error)
    } finally {
      record.inFlight = false
    }
  }

  async answer(request: AnswerRequest): Promise<AnswerResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status !== 'running') return this.terminalEcho(record)
    const stale = this.staleFromBinding(record)
    if (stale) return this.terminalEcho(stale)
    if (record.inFlight) {
      throw new ClarifyError('PROCESS_BUSY', 'process is already inferring', 'conflict')
    }
    record.inFlight = true
    try {
      const nextDecisions = this.prepareUserAnswer(record, request)
      const inferred = await this.runAnswerInference(record, nextDecisions)
      if (inferred.kind === 'terminal') return inferred.echo
      return this.commitAnswerOutput(record, nextDecisions, inferred.result)
    } catch (error) {
      throw this.asServiceError(error)
    } finally {
      record.inFlight = false
    }
  }

  async accept(request: AcceptRequest): Promise<AcceptResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status === 'complete') {
      if (request.previewVersion === record.previewVersion) return this.echo(record)
      throw new ClarifyError('PREVIEW_OUTDATED', 'previewVersion does not match the accepted preview', 'conflict')
    }
    if (record.status !== 'running') return this.echo(record)
    const stale = this.staleFromBinding(record)
    if (stale) return this.echo(stale)
    if (!record.previewVersion || request.previewVersion !== record.previewVersion) {
      throw new ClarifyError('PREVIEW_OUTDATED', 'previewVersion does not match the live preview', 'conflict')
    }
    if (typeof record.draftPreview !== 'string') {
      throw new ClarifyError('PREVIEW_OUTDATED', 'no live preview to accept', 'conflict')
    }
    if (record.inFlight) {
      throw new ClarifyError('PROCESS_BUSY', 'process is already inferring', 'conflict')
    }
    this.finalizeAccept(record)
    return this.echo(record)
  }

  async refine(request: RefineRequest): Promise<RefineResponse> {
    this.sweep()
    const record = this.mustGet(request.processId)
    if (record.status !== 'running') return this.terminalEcho(record)
    const stale = this.staleFromBinding(record)
    if (stale) return this.terminalEcho(stale)
    if (record.inFlight) {
      throw new ClarifyError('PROCESS_BUSY', 'process is already inferring', 'conflict')
    }
    this.validateRefine(record, request)
    record.inFlight = true
    try {
      const inferred = await this.runPublishedInference(
        record,
        this.inferenceInput(record, record.acceptedDecisions, request.feedback.trim()),
      )
      if (inferred.kind === 'terminal') return inferred.echo
      this.publishModelOutput(record, inferred.result)
      this.touch(record)
      return this.respondWithQuestion(record)
    } catch (error) {
      throw this.asServiceError(error)
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
      return this.respondWithQuestion(record)
    }
    if (record.status === 'complete') {
      return { ...this.echo(record), draft: record.draft }
    }
    return this.echo(record)
  }

  markStale(processId: string, reason: StaleReason): ProcessEcho {
    this.sweep()
    const record = this.mustGet(processId)
    if (record.status === 'running') this.applyStale(record, reason)
    return this.echo(record)
  }

  private prepareUserAnswer(record: ProcessRecord, request: AnswerRequest): AcceptedDecision[] {
    this.validateAnswer(record, request)
    const candidate = this.decisionFromRequest(record, request)
    this.touch(record)
    return cloneAcceptedDecisions([...record.acceptedDecisions, candidate])
  }

  private decisionFromRequest(record: ProcessRecord, request: AnswerRequest): AcceptedDecision {
    const questionText = record.question!.text
    if (request.customText !== undefined) {
      return { questionText, answer: 'custom', customText: request.customText }
    }
    const selected = request.selectedOptionIds ?? []
    const byId = new Map((record.question?.options ?? []).map((option) => [option.optionId, option.text]))
    const selectedOptionTexts = selected.map((optionId) => byId.get(optionId)!) as [string, ...string[]]
    return { questionText, answer: 'selected_options', selectedOptionTexts }
  }

  private async runAnswerInference(
    record: ProcessRecord,
    nextDecisions: AcceptedDecision[],
  ): Promise<{ kind: 'terminal'; echo: AnswerResponse } | { kind: 'result'; result: ModelInference }> {
    return await this.runPublishedInference(record, this.inferenceInput(record, nextDecisions))
  }

  private async runPublishedInference(
    record: ProcessRecord,
    input: InferenceInput,
  ): Promise<{ kind: 'terminal'; echo: AnswerResponse } | { kind: 'result'; result: ModelInference }> {
    let result: ModelInference | string
    try {
      result = await this.inference.infer(input, record.abort.signal)
    } catch (error) {
      if (record.abort.signal.aborted || record.status !== 'running') {
        return { kind: 'terminal', echo: this.terminalEcho(record) }
      }
      throw error
    }
    if (record.status !== 'running') return { kind: 'terminal', echo: this.terminalEcho(record) }
    const after = this.staleFromBinding(record)
    if (after) return { kind: 'terminal', echo: this.terminalEcho(after) }
    const model = await this.resolveModelOutput(record, input, result)
    if (!model || record.status !== 'running') {
      return { kind: 'terminal', echo: this.terminalEcho(record) }
    }
    return { kind: 'result', result: model }
  }

  private inferenceInput(
    record: ProcessRecord,
    acceptedDecisions: readonly AcceptedDecision[],
    refineFeedback?: string,
  ): InferenceInput {
    const prior = this.priorFromRecord(record)
    return {
      sessionId: record.sessionId,
      ...record.seedText === undefined ? {} : { seedText: record.seedText },
      acceptedDecisions: cloneAcceptedDecisions(acceptedDecisions),
      ...prior === undefined ? {} : { priorPublishedDraft: prior },
      ...refineFeedback === undefined ? {} : { refineFeedback },
      ...record.snapshot === undefined ? {} : { snapshot: record.snapshot },
    }
  }

  private priorFromRecord(record: ProcessRecord): PriorPublishedDraft | undefined {
    if (record.draftPreview === undefined || record.materialChanges === undefined) return undefined
    return {
      draftPreview: record.draftPreview,
      materialChanges: [...record.materialChanges],
    }
  }

  private async resolveModelOutput(
    record: ProcessRecord,
    input: InferenceInput,
    raw: ModelInference | string,
  ): Promise<ModelInference | undefined> {
    try {
      return applyModelInference(raw)
    } catch (error) {
      if (typeof raw !== 'string' || typeof this.inference.repair !== 'function') throw error
      if (record.abort.signal.aborted || record.status !== 'running') return undefined
      if (this.staleFromBinding(record)) return undefined
      const reason = error instanceof Error ? error.message : 'parse failed'
      const repaired = await this.inference.repair({
        ...input,
        routeId: record.modelRouteId,
        raw,
        reason,
      }, record.abort.signal)
      if (record.abort.signal.aborted || record.status !== 'running') return undefined
      if (this.staleFromBinding(record)) return undefined
      return applyModelInference(repaired)
    }
  }

  private commitAnswerOutput(
    record: ProcessRecord,
    nextDecisions: AcceptedDecision[],
    result: ModelInference | string,
  ): AnswerResponse {
    this.publishModelOutput(record, result)
    record.acceptedDecisions = cloneAcceptedDecisions(nextDecisions)
    this.touch(record)
    return this.respondWithQuestion(record)
  }

  private publishModelOutput(record: ProcessRecord, raw: ModelInference | string): void {
    let model: ModelInference
    try {
      model = applyModelInference(raw)
    } catch (error) {
      throw this.asServiceError(error)
    }
    if (!isMaterialPreviewChange(record.draftPreview, model.draftPreview)) {
      throw new ClarifyError('INVALID_ANSWER', 'inference preview is not a material change', 'retryable')
    }
    const nextVersion = this.opaqueIdFactory()
    const nextQuestion = model.kind === 'ask' ? this.hostQuestion(model) : undefined
    const nextChanges = [...model.materialChanges]
    record.draftPreview = model.draftPreview
    record.previewVersion = nextVersion
    record.materialChanges = nextChanges
    record.question = nextQuestion
  }

  private hostQuestion(model: ModelAsk): ClarifyQuestion {
    return {
      questionId: this.opaqueIdFactory(),
      text: model.question,
      options: model.options.map((text) => ({
        optionId: this.opaqueIdFactory(),
        text,
      })),
      multiple: model.multiple,
      allowCustom: model.allowCustom,
    }
  }

  private validateRefine(record: ProcessRecord, request: RefineRequest): void {
    if (typeof request.previewVersion !== 'string' || request.previewVersion.trim() === '') {
      throw new ClarifyError('INVALID_ANSWER', 'previewVersion is required', 'invalid-request')
    }
    if (request.previewVersion !== record.previewVersion) {
      throw new ClarifyError('PREVIEW_OUTDATED', 'previewVersion does not match the live preview', 'conflict')
    }
    if (typeof record.draftPreview !== 'string') {
      throw new ClarifyError('PREVIEW_OUTDATED', 'no live preview to refine', 'conflict')
    }
    if (typeof request.feedback !== 'string' || request.feedback.trim() === '') {
      throw new ClarifyError('INVALID_ANSWER', 'feedback must not be empty', 'invalid-request')
    }
  }

  private validateAnswer(record: ProcessRecord, request: AnswerRequest): void {
    if (typeof request.previewVersion !== 'string' || request.previewVersion.trim() === '') {
      throw new ClarifyError('INVALID_ANSWER', 'previewVersion is required', 'invalid-request')
    }
    if (request.previewVersion !== record.previewVersion) {
      throw new ClarifyError('PREVIEW_OUTDATED', 'previewVersion does not match the live preview', 'conflict')
    }
    const question = record.question
    if (!question || question.questionId !== request.questionId) {
      throw new ClarifyError('INVALID_ANSWER', 'questionId does not match the current question', 'conflict')
    }
    const hasOptions = request.selectedOptionIds !== undefined
    const hasCustom = request.customText !== undefined
    if (hasOptions === hasCustom) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds and customText are mutually exclusive and required as one of the two', 'invalid-request')
    }
    if (hasCustom) {
      if (!question.allowCustom) {
        throw new ClarifyError('INVALID_ANSWER', 'customText is only valid when allowCustom is true', 'invalid-request')
      }
      if (request.customText!.trim() === '') {
        throw new ClarifyError('INVALID_ANSWER', 'customText must not be empty', 'invalid-request')
      }
      return
    }
    const selected = request.selectedOptionIds ?? []
    if (selected.length === 0) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must not be empty', 'invalid-request')
    }
    if (new Set(selected).size !== selected.length) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must not contain duplicates', 'invalid-request')
    }
    if (selected.some((optionId) => typeof optionId !== 'string' || optionId.trim() === '')) {
      throw new ClarifyError('INVALID_ANSWER', 'selectedOptionIds must contain non-empty optionId values', 'invalid-request')
    }
    if (!question.multiple && selected.length !== 1) {
      throw new ClarifyError('INVALID_ANSWER', 'multiple=false requires exactly one selectedOptionId', 'invalid-request')
    }
    if (question.multiple && selected.length < 1) {
      throw new ClarifyError('INVALID_ANSWER', 'multiple=true requires at least one selectedOptionId', 'invalid-request')
    }
    const allowed = new Set(question.options.map((option) => option.optionId))
    for (const optionId of selected) {
      if (!allowed.has(optionId)) {
        throw new ClarifyError('INVALID_ANSWER', `unknown optionId ${optionId}`, 'invalid-request')
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
    if (record.status !== 'running') return record
    record.abort.abort()
    this.onCancelInFlight?.(record.processId)
    this.runningBySession.delete(record.sessionId)
    record.status = 'stale'
    record.staleReason = reason
    record.question = undefined
    record.draft = undefined
    record.draftPreview = undefined
    record.previewVersion = undefined
    record.materialChanges = undefined
    record.inFlight = false
    this.touch(record)
    return record
  }

  private finalizeAccept(record: ProcessRecord): void {
    if (record.status !== 'running') return
    record.abort.abort()
    this.onCancelInFlight?.(record.processId)
    record.status = 'complete'
    record.draft = record.draftPreview
    record.question = undefined
    record.inFlight = false
    this.runningBySession.delete(record.sessionId)
    this.touch(record)
  }

  private finalizeCancel(record: ProcessRecord): void {
    if (record.status !== 'running') return
    record.abort.abort()
    try {
      this.onCancelInFlight?.(record.processId)
    } finally {
      record.status = 'cancelled'
      record.question = undefined
      record.draft = undefined
      record.draftPreview = undefined
      record.previewVersion = undefined
      record.materialChanges = undefined
      record.inFlight = false
      this.runningBySession.delete(record.sessionId)
      this.touch(record)
    }
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
      if (record.status === 'running') {
        this.applyStale(record, 'ttl-expired')
      } else {
        this.processes.delete(record.processId)
      }
    }
  }

  private touch(record: ProcessRecord): void {
    record.lastActivity = this.now()
  }

  private mustGet(processId: string): ProcessRecord {
    const record = this.processes.get(processId)
    if (!record) throw new ClarifyError('PROCESS_NOT_FOUND', `process ${processId} does not exist`, 'conflict')
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
      ...this.publishedPreviewVersion(record),
    }
  }

  private publishedPreviewVersion(record: ProcessRecord): { previewVersion?: string } {
    if (record.status === 'stale' || record.status === 'cancelled') return {}
    if (record.previewVersion === undefined) return {}
    return { previewVersion: record.previewVersion }
  }

  private terminalEcho(record: ProcessRecord): AnswerResponse {
    return this.echo(record)
  }

  private startEcho(record: ProcessRecord): StartResponse {
    return this.respondWithQuestion(record)
  }

  private respondWithQuestion(record: ProcessRecord): StartResponse {
    if (record.status !== 'running') return this.echo(record)
    const question = cloneQuestion(record.question)
    if (
      record.previewVersion === undefined
      || record.draftPreview === undefined
      || record.materialChanges === undefined
    ) {
      throw new ClarifyError('INVALID_ANSWER', 'running process is missing its published preview', 'protocol')
    }
    return {
      ...this.echo(record),
      kind: question === undefined ? 'await_accept' : 'ask',
      ...(question === undefined ? {} : { question }),
      draftPreview: record.draftPreview,
      materialChanges: [...record.materialChanges],
    }
  }

  private resolveStartBinding(sessionId: string): ResolvedHostBinding {
    try {
      return this.resolveBinding(sessionId)
    } catch (error) {
      if (isCarrierCancellation(error)) throw error
      if (error instanceof ClarifyError) throw error
      const message = error instanceof Error && error.message ? error.message : 'host binding is unavailable'
      throw new ClarifyError('INFERENCE_UNAVAILABLE', message, 'configuration')
    }
  }

  private asServiceError(error: unknown): ClarifyError {
    if (isCarrierCancellation(error)) throw error
    try {
      return toClarifyError(error)
    } catch {
      const message = error instanceof Error && error.message ? error.message : 'inference unavailable'
      return new ClarifyError('INFERENCE_UNAVAILABLE', message, 'retryable')
    }
  }
}

export function assertClarifyQuestion(value: unknown): ClarifyQuestion {
  if (!value || typeof value !== 'object') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question must be an object', 'protocol')
  }
  const question = value as ClarifyQuestion
  if (typeof question.questionId !== 'string' || question.questionId.trim() === '') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.questionId must be a non-empty string', 'protocol')
  }
  if (typeof question.text !== 'string' || question.text.trim() === '') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.text must be a non-empty string', 'protocol')
  }
  if (typeof question.multiple !== 'boolean' || typeof question.allowCustom !== 'boolean') {
    throw new ClarifyError('INVALID_ANSWER', 'inference question.multiple and allowCustom must be booleans', 'protocol')
  }
  if (!Array.isArray(question.options) || question.options.length === 0) {
    throw new ClarifyError('INVALID_ANSWER', 'inference question must include at least one option', 'protocol')
  }
  const ids = question.options.map((option) => option?.optionId)
  if (ids.some((optionId) => typeof optionId !== 'string' || optionId.trim() === '')) {
    throw new ClarifyError('INVALID_ANSWER', 'inference optionId values must be unique and non-empty', 'protocol')
  }
  if (new Set(ids).size !== ids.length) {
    throw new ClarifyError('INVALID_ANSWER', 'inference optionId values must be unique and non-empty', 'protocol')
  }
  if (question.options.some((option) => typeof option.text !== 'string' || option.text.trim() === '')) {
    throw new ClarifyError('INVALID_ANSWER', 'inference option text must be a non-empty string', 'protocol')
  }
  if (!question.multiple && question.options.length < 1) {
    throw new ClarifyError('INVALID_ANSWER', 'multiple=false requires at least one option', 'protocol')
  }
  if (question.multiple && question.options.length < 1) {
    throw new ClarifyError('INVALID_ANSWER', 'multiple=true requires at least one option', 'protocol')
  }
  return cloneQuestion(question)!
}

function cloneAcceptedDecisions(decisions: readonly AcceptedDecision[]): AcceptedDecision[] {
  return decisions.map((decision) => {
    if (decision.answer === 'custom') {
      return { questionText: decision.questionText, answer: 'custom', customText: decision.customText }
    }
    return {
      questionText: decision.questionText,
      answer: 'selected_options',
      selectedOptionTexts: [...decision.selectedOptionTexts] as [string, ...string[]],
    }
  })
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

export type { HostBinding }

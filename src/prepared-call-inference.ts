import { buildClarifyOneShotRequest, type ClarifyOneShotRequest, type ClarifyRepairData } from './inference-prompt.ts'
import { ClarifyError, type InferenceCallConfig, type InferenceEngine, type InferenceInput, type InferenceRepairInput } from './types.ts'

export const MAX_MODEL_OUTPUT_CHARS = 256 * 1024

export type PreparedStreamChunk =
  | { type: 'block-start'; blockType: string }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta' }
  | { type: 'block-end'; block?: { type?: string } }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind: string } }

export interface PreparedGenerateOptions extends ClarifyOneShotRequest {
  signal: AbortSignal
}

export interface PreparedCallLike {
  readonly config: Readonly<InferenceCallConfig>
  stream(options: PreparedGenerateOptions): AsyncIterable<PreparedStreamChunk>
}

export interface PreparedCallLlmLike {
  prepareCall(config: InferenceCallConfig, signal?: AbortSignal): Promise<PreparedCallLike>
}

export interface PreparedCallInferenceOptions {
  llm: PreparedCallLlmLike
  /** Production callers must provide an explicit live authorization gate. */
  isDispatchAuthorized?: () => boolean
}

export class PreparedCallInferenceEngine implements InferenceEngine {
  private readonly llm: PreparedCallLlmLike
  private readonly isDispatchAuthorized: () => boolean

  constructor(options: PreparedCallInferenceOptions) {
    this.llm = options.llm
    this.isDispatchAuthorized = options.isDispatchAuthorized ?? (() => false)
  }

  async infer(input: InferenceInput, signal: AbortSignal): Promise<string> {
    return await this.dispatch(input, signal)
  }

  async repair(input: InferenceRepairInput, signal: AbortSignal): Promise<string> {
    if (!input.snapshot || input.routeId !== input.snapshot.modelRouteId) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'repair route does not match the captured Host route', 'conflict')
    }
    return await this.dispatch(input, signal, { raw: input.raw, reason: input.reason })
  }

  private async dispatch(input: InferenceInput, signal: AbortSignal, repair?: ClarifyRepairData): Promise<string> {
    if (!this.isDispatchAuthorized()) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'prepared model dispatch is not authorized', 'configuration')
    }
    throwIfAborted(signal)
    const snapshot = input.snapshot
    if (!snapshot) throw new ClarifyError('INFERENCE_UNAVAILABLE', 'prepared model dispatch requires a Host snapshot', 'configuration')
    const contextWindow = snapshot.requestContext?.contextWindow
    if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'requestContext.contextWindow must be a finite positive number', 'configuration')
    }
    const proposedConfig = cloneCallConfig(snapshot.callConfig)
    const prepared = await this.llm.prepareCall(proposedConfig, signal)
    if (
      prepared.config.provider !== snapshot.callConfig.provider
      || prepared.config.model !== snapshot.callConfig.model
    ) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'prepared model route differs from the captured Host route', 'conflict')
    }
    const request = buildClarifyOneShotRequest(input, {
      ...repair === undefined ? {} : { repair },
      ...prepared.config.maxTokens === undefined ? {} : { outputTokenReserve: prepared.config.maxTokens },
    })
    const preparedConfig = cloneCallConfig(prepared.config)
    const options: PreparedGenerateOptions = {
      ...preparedConfig,
      system: request.system,
      messages: request.messages,
      sessionId: request.sessionId,
      signal,
    }
    if (!callConfigEquals(options, preparedConfig)) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'prepared model call config changed before dispatch', 'conflict')
    }
    const text: string[] = []
    let textLength = 0
    let sawFinish = false
    for await (const chunk of prepared.stream(options)) {
      throwIfAborted(signal)
      if (sawFinish) throw new ClarifyError('INVALID_ANSWER', 'Clarify model stream emitted data after finish', 'retryable')
      if (chunk.type === 'text-delta') {
        text.push(chunk.text)
        textLength += chunk.text.length
        if (textLength > MAX_MODEL_OUTPUT_CHARS) {
          throw new ClarifyError('INVALID_ANSWER', 'Clarify model output exceeded the safety limit', 'retryable')
        }
        continue
      }
      if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) {
        throw new ClarifyError('INVALID_ANSWER', 'Clarify model output attempted a tool call', 'retryable')
      }
      if (chunk.type === 'finish') {
        sawFinish = true
        if (chunk.reason.kind !== 'stop') {
          throw new ClarifyError(
            chunk.reason.kind === 'aborted' || chunk.reason.kind === 'error' ? 'INFERENCE_UNAVAILABLE' : 'INVALID_ANSWER',
            `Clarify model stream ended with ${chunk.reason.kind}`,
            'retryable',
          )
        }
        continue
      }
    }
    if (!sawFinish) throw new ClarifyError('INFERENCE_UNAVAILABLE', 'Clarify model stream ended without a finish chunk', 'retryable')
    const raw = text.join('')
    if (!raw.trim()) throw new ClarifyError('INVALID_ANSWER', 'Clarify model stream returned no visible JSON', 'retryable')
    return raw
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  throw error
}

export function callConfigEquals(a: Readonly<InferenceCallConfig>, b: Readonly<InferenceCallConfig>): boolean {
  return a.provider === b.provider
    && a.model === b.model
    && a.reasoningEffort === b.reasoningEffort
    && a.temperature === b.temperature
    && a.maxTokens === b.maxTokens
    && stringListEquals(a.stop, b.stop)
}

function stringListEquals(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function cloneCallConfig(config: Readonly<InferenceCallConfig>): InferenceCallConfig {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
    ...config.temperature === undefined ? {} : { temperature: config.temperature },
    ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
    ...config.stop === undefined ? {} : { stop: [...config.stop] },
  }
}

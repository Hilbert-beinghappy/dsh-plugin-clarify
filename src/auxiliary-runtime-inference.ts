import { randomUUID } from 'node:crypto'
import { buildClarifyOneShotRequest, type ClarifyRepairData } from './inference-prompt.ts'
import {
  ClarifyError,
  type InferenceCallConfig,
  type InferenceEngine,
  type InferenceInput,
  type InferenceRepairInput,
} from './types.ts'

interface AuxiliaryUsageBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

interface AuxiliaryFailureFact {
  readonly category: 'quota' | 'context_window' | 'aborted' | 'error' | 'conflict' | 'limit' | 'unavailable'
  readonly code: string
}

interface AuxiliaryCallResult {
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
  readonly output: string | null
  readonly failure?: AuxiliaryFailureFact
}

interface AuxiliaryPreparedView {
  readonly config: InferenceCallConfig
  readonly context?: { readonly contextWindow: number }
  readonly adapterDefaults: {
    readonly reasoningEffort?: true
    readonly maxTokens?: true
  }
}

interface AuxiliaryPreparedRequest {
  readonly system?: string
  readonly messages: readonly unknown[]
  readonly reservation: AuxiliaryUsageBuckets
}

interface AuxiliaryRunRequest {
  readonly callId: string
  readonly sessionId: string
  readonly purpose: 'clarify'
  readonly config: InferenceCallConfig
  readonly prepareRequest: (prepared: AuxiliaryPreparedView) => AuxiliaryPreparedRequest
  readonly signal: AbortSignal
}

export interface AuxiliaryRuntimeLike {
  run(request: AuxiliaryRunRequest): Promise<AuxiliaryCallResult>
}

export interface AuxiliaryRuntimeInferenceOptions {
  runtime: AuxiliaryRuntimeLike
  idFactory?: () => string
}

/** Production inference adapter: prompt ownership here, dispatch/accounting ownership in auxiliaryRuntime. */
export class AuxiliaryRuntimeInferenceEngine implements InferenceEngine {
  private readonly runtime: AuxiliaryRuntimeLike
  private readonly idFactory: () => string

  constructor(options: AuxiliaryRuntimeInferenceOptions) {
    this.runtime = options.runtime
    this.idFactory = options.idFactory ?? (() => randomUUID())
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

  private async dispatch(
    input: InferenceInput,
    signal: AbortSignal,
    repair?: ClarifyRepairData,
  ): Promise<string> {
    throwIfAborted(signal)
    const snapshot = input.snapshot
    if (!snapshot) {
      throw new ClarifyError('INFERENCE_UNAVAILABLE', 'auxiliary inference requires a Host snapshot', 'configuration')
    }
    const config = cloneCallConfig(snapshot.callConfig)
    const result = await this.runtime.run({
      callId: `clarify-${this.idFactory()}`,
      sessionId: snapshot.sessionId,
      purpose: 'clarify',
      config,
      prepareRequest: (prepared) => {
        if (
          prepared.config.provider !== snapshot.callConfig.provider
          || prepared.config.model !== snapshot.callConfig.model
        ) {
          throw new ClarifyError(
            'INFERENCE_UNAVAILABLE',
            'prepared model route differs from the captured Host route',
            'conflict',
          )
        }
        const outputTokenReserve = positiveSafeInteger(prepared.config.maxTokens, 'prepared maxTokens')
        const contextWindow = positiveSafeInteger(prepared.context?.contextWindow, 'prepared contextWindow')
        const request = buildClarifyOneShotRequest(input, {
          contextWindow,
          outputTokenReserve,
          ...repair === undefined ? {} : { repair },
        })
        return {
          system: request.system,
          messages: request.messages,
          reservation: reservationFor(request, outputTokenReserve),
        }
      },
      signal,
    })
    if (signal.aborted) throwIfAborted(signal)
    if (result.status === 'succeeded' && typeof result.output === 'string') return result.output
    throw resultError(result)
  }
}

export function asAuxiliaryRuntime(value: unknown): AuxiliaryRuntimeLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  return typeof (value as AuxiliaryRuntimeLike).run === 'function' ? value as AuxiliaryRuntimeLike : undefined
}

function reservationFor(
  request: { readonly system: string; readonly messages: readonly unknown[] },
  outputTokens: number,
): AuxiliaryUsageBuckets {
  const uncachedInputTokens = Buffer.byteLength(JSON.stringify({
    system: request.system,
    messages: request.messages,
  }), 'utf8')
  if (!Number.isSafeInteger(uncachedInputTokens)) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'Clarify reservation exceeds the safe integer range', 'configuration')
  }
  return { uncachedInputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function resultError(result: AuxiliaryCallResult): ClarifyError {
  const failure = result.failure
  const code = failure?.code ?? (result.status === 'cancelled' ? 'ABORTED' : 'UNKNOWN')
  if (code === 'OUTPUT_TOO_LARGE' || code === 'INVALID_ANSWER') {
    return new ClarifyError('INVALID_ANSWER', `auxiliary model output was rejected (${code})`, 'retryable')
  }
  const category = failure?.category === 'conflict'
    ? 'conflict'
    : failure?.category === 'quota'
      || failure?.category === 'context_window'
      || failure?.category === 'aborted'
      || failure?.category === 'error'
      ? 'retryable'
      : 'configuration'
  return new ClarifyError('INFERENCE_UNAVAILABLE', `auxiliary model call did not succeed (${code})`, category)
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', `${field} must be a positive safe integer`, 'configuration')
  }
  return value
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  throw error
}

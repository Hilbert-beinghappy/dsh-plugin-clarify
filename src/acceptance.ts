import {
  CLARIFY_ACCEPTANCE_COMPOSE,
  createClarifyAcceptancePayload,
  type ClarifyAcceptanceDisposer,
  type ClarifyAcceptanceTarget,
} from './acceptance-channel.ts'
import {
  PreparedCallInferenceEngine,
  type PreparedCallLlmLike,
} from './prepared-call-inference.ts'
import { ClarifyError } from './types.ts'

export const ACCEPTANCE_REQUIRED_INJECT = ['clarify', 'llm'] as const

export interface AcceptedHostInferenceOptions {
  llm: PreparedCallLlmLike
  isDispatchAuthorized: () => boolean
}

/**
 * Acceptance-only in-process composition point. The caller must pass the live
 * `ready.clarify` service from a child fiber that injects Clarify and llm.
 */
export function composeAcceptedHostInference(
  clarify: unknown,
  options: AcceptedHostInferenceOptions,
): ClarifyAcceptanceDisposer {
  if (typeof options?.isDispatchAuthorized !== 'function') {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'acceptance composition requires a live authorization callback', 'configuration')
  }
  const compose = (clarify as ClarifyAcceptanceTarget | undefined)?.[CLARIFY_ACCEPTANCE_COMPOSE]
  if (typeof compose !== 'function') {
    throw new ClarifyError('INFERENCE_UNAVAILABLE', 'live Clarify service does not expose the acceptance composition hook', 'configuration')
  }
  return compose(createClarifyAcceptancePayload(new PreparedCallInferenceEngine(options)))
}

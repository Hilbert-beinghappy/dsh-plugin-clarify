import type { InferenceEngine } from './types.ts'

export const CLARIFY_ACCEPTANCE_COMPOSE = Symbol('dsh-plugin-clarify.acceptance-compose')
const CLARIFY_ACCEPTANCE_PAYLOAD = Symbol('dsh-plugin-clarify.acceptance-payload')

export type ClarifyAcceptanceDisposer = () => void
export type ClarifyAcceptanceCompose = (payload: unknown) => ClarifyAcceptanceDisposer

export interface ClarifyAcceptanceTarget {
  [CLARIFY_ACCEPTANCE_COMPOSE]?: ClarifyAcceptanceCompose
}

interface ClarifyAcceptancePayload {
  readonly [CLARIFY_ACCEPTANCE_PAYLOAD]: true
  readonly engine: InferenceEngine
}

export function createClarifyAcceptancePayload(engine: InferenceEngine): unknown {
  return Object.freeze({
    [CLARIFY_ACCEPTANCE_PAYLOAD]: true,
    engine,
  } satisfies ClarifyAcceptancePayload)
}

export function acceptedInferenceEngine(payload: unknown): InferenceEngine | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const candidate = payload as Partial<ClarifyAcceptancePayload>
  if (candidate[CLARIFY_ACCEPTANCE_PAYLOAD] !== true) return undefined
  return typeof candidate.engine?.infer === 'function' ? candidate.engine : undefined
}

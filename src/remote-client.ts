import { CLARIFY_REMOTE_METHODS, CLARIFY_REMOTE_NAMESPACE, type ClarifyRemoteMethod } from './compat.ts'

export const CLARIFY_API_CHANNEL = '/api'

export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: { args: Record<string, unknown> }
}

export interface ServerResponseEnvelope {
  type: 'server-response'
  rpcId: string
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }
}

export function clarifyEndpoint(method: ClarifyRemoteMethod): string {
  return `${CLARIFY_REMOTE_NAMESPACE}/${method}`
}

export function clarifyClientRequest(
  method: ClarifyRemoteMethod,
  args: Record<string, unknown>,
  rpcId = crypto.randomUUID(),
): ClientRequestEnvelope {
  if (!CLARIFY_REMOTE_METHODS.includes(method)) {
    throw new Error(`unknown clarify method ${method}`)
  }
  return {
    type: 'client-request',
    rpcId,
    method: clarifyEndpoint(method),
    payload: { args: omitUndefined(args) },
  }
}

export function apiPath(endpoint: string): string {
  return `${CLARIFY_API_CHANNEL}/${endpoint}`
}

function omitUndefined(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.length === 0 && key !== 'sessionId' && key !== 'processId' && key !== 'questionId' && key !== 'previewVersion') {
      continue
    }
    if (key === 'selectedOptionIds' && Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

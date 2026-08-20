import { ClarifyService } from './clarify-service.ts'
import { ClarifyError } from './types.ts'
import type { AnswerResponse, CancelResponse, FetchDraftResponse, StartResponse } from './types.ts'

export type ClarifyRpcMethod = 'start' | 'answer' | 'cancel' | 'fetchDraft'

export interface ClarifyRpcRequest {
  method: string
  params?: Record<string, unknown>
}

export async function dispatchClarifyRpc(
  service: ClarifyService,
  method: string,
  params: Record<string, unknown> = {},
): Promise<StartResponse | AnswerResponse | CancelResponse | FetchDraftResponse> {
  switch (method) {
    case 'start':
      return await service.start({
        sessionId: String(params.sessionId ?? ''),
        ...params.seedText === undefined ? {} : { seedText: String(params.seedText) },
      })
    case 'answer':
      return await service.answer({
        processId: String(params.processId ?? ''),
        questionId: String(params.questionId ?? ''),
        ...params.selectedOptionIds === undefined ? {} : { selectedOptionIds: asStringArray(params.selectedOptionIds) },
        ...params.customText === undefined ? {} : { customText: String(params.customText) },
      })
    case 'cancel':
      return await service.cancel({ processId: String(params.processId ?? '') })
    case 'fetchDraft':
      return await service.fetchDraft({ processId: String(params.processId ?? '') })
    default:
      throw new ClarifyError('INVALID_ANSWER', `unknown method ${method}`)
  }
}

export async function dispatchClarifyRpcBody(
  service: ClarifyService,
  body: ClarifyRpcRequest,
): Promise<StartResponse | AnswerResponse | CancelResponse | FetchDraftResponse> {
  return await dispatchClarifyRpc(service, body.method, body.params ?? {})
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item))
}

export const CLARIFY_RPC_METHODS: readonly ClarifyRpcMethod[] = ['start', 'answer', 'cancel', 'fetchDraft']

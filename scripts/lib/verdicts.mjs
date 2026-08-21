export function verdictA(usage, evidence) {
  if (!evidence?.httpProbe) {
    return { status: '阻塞', reason: '未取到本进程 /clarify/probe JSON（拒绝把外来 3080/SPA 响应算作探针）' }
  }
  const observed = usage?.status === 'observed'
  const offTranscript = usage?.offTranscript === true
  const noStreamError = !usage?.streamError
  const noAdapterError = !usage?.adapterError
  const zeroEvents = usage?.eventCountDelta === 0
  const zeroDerived = usage?.derivedDelta === 0
  if (observed && offTranscript && noStreamError && noAdapterError && zeroEvents && zeroDerived) {
    return {
      status: '可行',
      reason: '直接 ctx.llm.stream（探针 adapter、no-tools、未 markAgentLoopRequest）成功，且 session 事件/deriveMessages 计数未增加。未证明走 Session 现网 provider 路由',
    }
  }
  return {
    status: '阻塞',
    reason: usage?.streamError || usage?.adapterError || usage?.reason || '未能证明 off-transcript no-tools 补全',
  }
}

export function verdictB(header) {
  if (header?.status === 'observed' && header.hasSystemField && header.hasToolsField && header.hasProvider && header.hasModel) {
    if (header.liveSystemToolsChangeWithoutNewMessages?.status !== 'observed') {
      return {
        status: '阻塞',
        reason: 'requestHeader 字段面存在，但未现场观察到 system/tools 在无新消息时变化',
      }
    }
    return { status: '可行', reason: '公开 requestHeader 覆盖 system/tools/config 三元组' }
  }
  return { status: '阻塞', reason: header?.reason || '新鲜 Session 无 requestHeader，且无独立 context revision id' }
}

export const CLARIFY_ENDPOINTS = ['clarify/start', 'clarify/answer', 'clarify/cancel', 'clarify/fetchDraft']
export const BUSINESS_REMOTE_CODES = new Set([
  'PROCESS_NOT_FOUND',
  'PROCESS_BUSY',
  'SESSION_ID_REQUIRED',
  'INVALID_ANSWER',
  'PREVIEW_OUTDATED',
  'INFERENCE_UNAVAILABLE',
])
export const INFRA_REMOTE_CODES = new Set([
  'invocation-unavailable',
  'definition-unavailable',
  'service-unavailable',
])

export function isInfrastructureRemoteFailure(input = {}) {
  const message = String(input.message ?? input.error ?? input.error?.message ?? '')
  const code = String(input.code ?? input.errorCode ?? input.error?.code ?? '')
  const status = input.httpStatus ?? input.status
  if (status === 404) return true
  if (INFRA_REMOTE_CODES.has(code)) return true
  return /no active Remote method|invocation-unavailable|definition-unavailable|service-unavailable|active Service .+ is unavailable|^not found$/i.test(message)
}

export function isBusinessRemoteArrival(input = {}) {
  if (isInfrastructureRemoteFailure(input)) return false
  const code = input.code ?? input.errorCode ?? input.error?.code
  if (BUSINESS_REMOTE_CODES.has(code)) return true
  if (typeof input.processId === 'string') return true
  if (input.value && typeof input.value === 'object' && typeof input.value.processId === 'string') return true
  const message = String(input.message ?? input.error ?? input.error?.message ?? '')
  return /PROCESS_NOT_FOUND|SESSION_ID_REQUIRED|INVALID_ANSWER|process .+ does not exist|sessionId is required|session .+ is not available/i.test(message)
}

export function namespaceClaimed(web) {
  const listed = web?.typertLocalEndpoints
  if (!Array.isArray(listed)) return false
  return CLARIFY_ENDPOINTS.every((endpoint) => listed.includes(endpoint))
}

export function carrierHit(consumer) {
  const endpoints = consumer?.endpoints
  if (!endpoints || typeof endpoints !== 'object') return false
  return ['start', 'answer', 'cancel', 'fetchDraft'].every((method) => {
    const item = endpoints[method]
    return Boolean(item && (item.kind === 'business' || item.status === 'hit'))
  })
}

export function httpCarrierHit(remote, hostT3) {
  const start = hostT3?.endpoints?.start ?? remote
  if (!start) return false
  const payload = {
    message: start.textPreview ?? start.error?.message ?? start.text,
    code: start.errorCode ?? start.error?.code,
    httpStatus: start.status,
    value: start.value,
  }
  if (isInfrastructureRemoteFailure(payload)) return false
  return isBusinessRemoteArrival(payload)
}

export function verdictC(web, evidence) {
  const claimed = namespaceClaimed(web) && web?.clarifyRemoteClaimed === true
  const gatewayHit = carrierHit(web?.consumerPath)
  const httpHit = httpCarrierHit(evidence?.httpRemote, evidence?.http?.hostT3)
  if (claimed && (gatewayHit || httpHit)) {
    return {
      status: '可行',
      reason: 'typert.local 已 claim 四端点，且 Gateway 或 /api 信封以 Clarify 业务错误/结果命中 receiver',
    }
  }
  const reasons = []
  if (!claimed) reasons.push('typert.local 未列出 clarify/start|answer|cancel|fetchDraft')
  if (!gatewayHit && !httpHit) {
    reasons.push('Gateway/HTTP 未以业务错误命中 receiver（invocation-unavailable / 404 只证明基础设施阻塞）')
  }
  return { status: '阻塞', reason: reasons.join('；') }
}

export function verdictD(usage) {
  if (usage?.probeCreatedSession === true || usage?.sessionSource === 'created-by-probe') {
    return {
      status: '阻塞',
      reason: '未用已存在的用户 Session 证明 Harness usage 归属；禁止用探针新建 Session、假 assistant/message、私有计量器或未证明的 Session 日志写入来伪装 (d)',
    }
  }
  const before = usage?.usageMeasureBefore
  const after = usage?.usageMeasureAfter
  if (
    usage?.status === 'observed'
    && usage?.sessionSource === 'existing'
    && JSON.stringify(before) !== JSON.stringify(after)
    && after
    && !after.error
  ) {
    return { status: '可行', reason: '已存在 Session 上的 tokenMeter.measure 在直接 stream 前后发生变化' }
  }
  return {
    status: '阻塞',
    reason: '未观察到 Harness usage 投影因直接 ctx.llm.stream 而记入已存在 Session；limits/cancel 通道也未在本探针中被触发',
  }
}

export function gateTable(probe, extras = {}) {
  const usage = probe?.usage ?? {}
  const header = probe?.header ?? {}
  const web = probe?.web ?? {}
  const evidence = { httpProbe: probe, ...extras }
  return {
    a: verdictA(usage, evidence),
    b: verdictB(header),
    c: verdictC(web, evidence),
    d: verdictD(usage),
  }
}

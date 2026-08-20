export const CLARIFY_NAMESPACE = 'clarify'
export const CLARIFY_METHODS = ['start', 'answer', 'cancel', 'fetchDraft']

export function clientRequest(method, payload, rpcId = crypto.randomUUID()) {
  return {
    type: 'client-request',
    rpcId,
    method,
    payload,
  }
}

export function clarifyRequest(method, args, rpcId) {
  if (!CLARIFY_METHODS.includes(method)) throw new Error(`unknown clarify method ${method}`)
  return clientRequest(`${CLARIFY_NAMESPACE}/${method}`, { args: omitUndefined(args) }, rpcId)
}

export async function postApi(origin, method, payload) {
  const envelope = clientRequest(method, payload)
  const response = await fetch(new URL(`/api/${method}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return {
    url: `/api/${method}`,
    status: response.status,
    rpcId: envelope.rpcId,
    json,
    textPreview: text.slice(0, 4000),
    ok: json?.type === 'server-response' && json?.result?.ok === true,
    value: json?.result?.ok === true ? json.result.value : undefined,
    error: json?.result?.ok === false ? json.result.error : undefined,
  }
}

export async function callClarify(origin, method, args) {
  return postApi(origin, `${CLARIFY_NAMESPACE}/${method}`, { args: omitUndefined(args) })
}

export async function createTestFixtureSession(origin) {
  const attempts = []
  const cwd = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.startsWith('/')
    ? process.env.DSH_HOME
    : undefined
  const candidates = [
    ['session.create', { fixture: 'test-fixture' }],
    ['session.create', cwd ? { cwd, fixture: 'test-fixture' } : {}],
    ['session.create', { args: cwd ? { cwd, fixture: 'test-fixture' } : { fixture: 'test-fixture' } }],
  ]
  for (const [method, payload] of candidates) {
    const result = await postApi(origin, method, payload)
    attempts.push({
      method,
      status: result.status,
      ok: result.ok,
      errorCode: result.error?.code,
      valueKeys: result.value && typeof result.value === 'object' ? Object.keys(result.value) : [],
    })
    const sessionId = pickSessionId(result.value, { allowTopLevelId: true })
    if (sessionId) {
      return {
        sessionId,
        method,
        created: true,
        fixture: 'isolated-test-fixture',
        createdBy: 't0-host-t3-script',
        attempts,
      }
    }
  }
  return {
    sessionId: undefined,
    created: false,
    blocked: true,
    reason: 'official session.create did not return a sessionId for the T3 test fixture',
    attempts,
  }
}

export async function discoverExistingSession(origin) {
  const attempts = []
  const candidates = [
    ['session.list', {}],
    ['session.list', { args: {} }],
    ['sessions.list', { args: {} }],
    ['session.current', {}],
    ['session.current', { args: {} }],
  ]
  for (const [method, payload] of candidates) {
    const result = await postApi(origin, method, payload)
    attempts.push({
      method,
      status: result.status,
      ok: result.ok,
      errorCode: result.error?.code,
      valueKeys: result.value && typeof result.value === 'object' ? Object.keys(result.value) : [],
    })
    const sessionId = pickSessionId(result.value, { fromList: true })
    if (sessionId) {
      return { sessionId, method, attempts, created: false }
    }
  }
  return {
    sessionId: undefined,
    created: false,
    blocked: true,
    reason: 'stock public remotes did not expose an existing sessionId',
    attempts,
  }
}

function looksLikeSessionId(value) {
  if (typeof value !== 'string') return false
  const id = value.trim()
  if (!id) return false
  if (id.includes('/')) return false
  if (/^(session|sessions|clarify)\.[A-Za-z]+$/.test(id)) return false
  return true
}

function pickSessionId(value, options = {}) {
  if (!value || typeof value !== 'object') return undefined
  if (looksLikeSessionId(value.sessionId)) return value.sessionId.trim()
  if (options.allowTopLevelId && looksLikeSessionId(value.id) && !Array.isArray(value.sessions ?? value.items ?? value.list)) {
    return value.id.trim()
  }
  const list = value.sessions ?? value.items ?? value.list
  if (!Array.isArray(list) || list.length === 0) return undefined
  for (const item of list) {
    if (looksLikeSessionId(item)) return item.trim()
    if (item && typeof item === 'object') {
      if (looksLikeSessionId(item.sessionId)) return item.sessionId.trim()
      if (looksLikeSessionId(item.id)) return item.id.trim()
    }
  }
  return undefined
}

export function labelHostT3Session(discovery, probeUsage = {}) {
  const productionPluginCreated = false
  if (!discovery?.sessionId) {
    return {
      method: discovery?.method,
      source: 'none',
      createdByHarness: Boolean(discovery?.created || probeUsage.probeCreatedSession),
      productionPluginCreated,
      createdByThisScript: discovery?.created === true,
      blocked: discovery?.blocked,
      reason: discovery?.reason,
      attempts: discovery?.attempts,
    }
  }
  if (discovery.created === true && discovery.createdBy === 't0-host-t3-script') {
    return {
      method: discovery.method,
      source: 't0-host-t3-script-fixture',
      createdByHarness: true,
      productionPluginCreated,
      createdByThisScript: true,
      fixture: 'isolated-test-fixture',
      note: 'Session was created by the T0 Host T3 script as an isolated test fixture. Production plugin and DIY must not create Session.',
    }
  }
  const fromProbe = probeUsage.probeCreatedSession === true
    || probeUsage.sessionSource === 'created-by-probe'
    || probeUsage.sessionSource === 't0-probe-test-fixture'
  if (fromProbe) {
    return {
      method: discovery.method,
      listedBy: discovery.method,
      source: 't0-probe-test-fixture',
      createdByHarness: true,
      productionPluginCreated,
      createdByThisScript: false,
      fixture: 'isolated-test-fixture',
      note: 'Session came from this T0 probe test fixture and was then found via session.list. Isolation only; production plugin and DIY must not create Session.',
    }
  }
  return {
    method: discovery.method,
    listedBy: discovery.method,
    source: 'preexisting-isolated-home',
    createdByHarness: false,
    productionPluginCreated,
    createdByThisScript: false,
    note: 'Existing session in the isolated home. Production plugin and DIY must not create Session.',
  }
}

function omitUndefined(args) {
  const out = {}
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'string' && value.length === 0 && key !== 'sessionId' && key !== 'processId' && key !== 'questionId') {
      continue
    }
    if (key === 'selectedOptionIds' && Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

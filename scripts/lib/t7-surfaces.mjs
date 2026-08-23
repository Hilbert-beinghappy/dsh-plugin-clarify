import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename as nodeBasename, join } from 'node:path'
import {
  T7_AUXILIARY_TGZ_NAME,
  T7_CLARIFY_RELEASE,
  T7_CLARIFY_TGZ_NAME,
  T7_DIY_METHODS,
  countBand,
  requireFromReleaseAssets,
  unavailableRead,
  usageBand,
  wrapAssetReadError,
} from './t7-schema.mjs'

export const OFFICIAL_PUBLIC_SOURCE = 'official-public-remote'

export function labelOfficialPublicSession({ createdByThisScript } = {}) {
  return {
    source: OFFICIAL_PUBLIC_SOURCE,
    productionPluginCreated: false,
    createdByThisScript: createdByThisScript === true,
  }
}

export function snapshotImmediateBeforeFirstClarifyRpc(snapshot = {}) {
  return {
    ...snapshot,
    immediate: true,
    beforeFirstClarifyRpc: true,
  }
}

export function stripProviderKeys(env) {
  const target = env ?? process.env
  delete target.OPENAI_API_KEY
  delete target.DEEPSEEK_API_KEY
  return target
}

export function createIsolatedWorkspacePath(home) {
  const base = typeof home === 'string' && home ? home : tmpdir()
  mkdirSync(base, { recursive: true })
  return mkdtempSync(join(base, 'clarify-t7-workspace-'))
}

export const OFFICIAL_SEND_LABELS = Object.freeze(['Send message', '发送消息'])
export const OFFICIAL_SEND_CONTROL_SELECTOR = 'button, [type="submit"], [role="button"]'
export const OFFICIAL_WELCOME_LABELS = Object.freeze(['Continue', '继续'])
export const OFFICIAL_ONBOARDING_LATER_LABELS = Object.freeze(['Configure later', '稍后配置'])
export const OFFICIAL_ONBOARDING_SAVE_LABELS = Object.freeze(['Save and continue', '保存并继续'])
export const WORKSPACE_TRIGGER_LABELS = Object.freeze(['Choose workspace', '选择工作区'])

export function listedSessionItems(value) {
  return Array.isArray(value?.items) ? value.items : null
}

export function listSessionIds(listValue) {
  const items = listedSessionItems(listValue)
  if (!items) return []
  const ids = []
  for (const item of items) {
    const id = officialSessionId(item)
    if (id) ids.push(id)
  }
  return ids
}

export function sessionListDelta(beforeIds, afterIds) {
  const before = listedIdValues(beforeIds)
  const after = listedIdValues(afterIds)
  if (before.length !== 0 || after.length !== 1 || before.includes(after[0])) {
    return { ok: false, code: 'SESSION_DELTA', category: 'environment' }
  }
  return { ok: true, id: after[0] }
}

export function isVisibleComposerCard(node = {}) {
  return node.card === true && node.visible === true
}

export function isOfficialSendLabel(label) {
  return OFFICIAL_SEND_LABELS.includes(label)
}

export function isWritableComposerTextarea(node = {}) {
  if (node.tag !== 'textarea') return false
  if (node.visible !== true) return false
  if (node.disabled === true || node.readOnly === true) return false
  if (node.dataPhase === 'inert') return false
  if (WORKSPACE_TRIGGER_LABELS.includes(node.ariaLabel)) return false
  return true
}

export function officialSendLocatorSelector(ariaLabel) {
  const label = String(ariaLabel ?? '')
  return OFFICIAL_SEND_CONTROL_SELECTOR
    .split(', ')
    .map((selector) => `${selector}[aria-label="${label}"]`)
    .join(', ')
}

export function planOfficialOnboardingAction(surface = {}) {
  const welcome = exactOnboardingMatches(surface.buttons, OFFICIAL_WELCOME_LABELS)
  const later = exactOnboardingMatches(surface.buttons, OFFICIAL_ONBOARDING_LATER_LABELS)
  const save = exactOnboardingMatches(surface.buttons, OFFICIAL_ONBOARDING_SAVE_LABELS)
  if (welcome.length > 1 || later.length > 1 || (welcome.length === 1 && later.length === 1) || (welcome.length === 1 && save.length > 0)) {
    return { ok: false, code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' }
  }
  if (welcome.length === 1) {
    return { ok: true, action: 'click-welcome', label: welcome[0] }
  }
  if (later.length === 1) {
    return { ok: true, action: 'click-later', label: later[0] }
  }
  if (save.length > 0) {
    return { ok: false, code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' }
  }
  if (surface.rootInert === true) {
    return { ok: false, code: 'ONBOARDING_BLOCKED', category: 'operator' }
  }
  return { ok: true, action: 'ready' }
}

export function classifyOnboardingDeadline(plan, options = {}) {
  if (plan?.ok === true && plan.action === 'ready') return plan
  if (options.clicked === true) {
    return { ok: false, code: 'ONBOARDING_PERSIST', category: 'environment' }
  }
  return { ok: false, code: 'ONBOARDING_MISSING', category: 'environment' }
}

export function selectOfficialComposerCard(cards = []) {
  const visible = []
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]
    if (isVisibleComposerCard(card)) visible.push({ card, cardIndex: card.cardIndex ?? index })
  }
  if (visible.length !== 1) {
    return { ok: false, code: 'COMPOSER_UNIDENTIFIED', category: 'operator' }
  }
  const { card, cardIndex } = visible[0]
  const textareas = (card.textareas ?? []).filter(isWritableComposerTextarea)
  const sends = (card.sends ?? []).filter((node) => isOfficialSendLabel(node?.ariaLabel))
  if (textareas.length !== 1 || sends.length !== 1) {
    return { ok: false, code: 'COMPOSER_UNIDENTIFIED', category: 'operator' }
  }
  return { ok: true, cardIndex, composer: textareas[0], send: sends[0] }
}

export function extractSessionCount(value) {
  const items = listedSessionItems(value)
  if (!items) return unavailableRead('no public session.list items[] read seam')
  return {
    available: true,
    status: 'observed',
    band: countBand(items.length),
  }
}

export function extractBlankTurns(item, options = {}) {
  const observed = blankTurnsFromValues(item?.projections?.values)
  if (observed) return observed
  if (options.allowFallback === true) {
    const fallback = blankTurnsFromValues({
      sessionListMetadata: item?.sessionListMetadata,
      sessionStats: item?.sessionStats,
    })
    if (fallback) return fallback
  }
  return unavailableRead('session.list item missing projections.values sessionListMetadata.blank or sessionStats.turns')
}

export function extractOfficialUsage(item, options = {}) {
  const observed = officialUsageFromBuckets(item?.projections?.values?.tokenUsage)
  if (observed) return observed
  if (options.allowFallback === true) {
    const fallback = officialUsageFromBuckets(item?.tokenUsage)
    if (fallback) return fallback
  }
  return unavailableRead('session.list item missing projections.values tokenUsage')
}

export function snapshotFromSessionList(listValue, sessionId) {
  const items = listedSessionItems(listValue)
  if (!items) {
    const missing = unavailableRead('no public session.list items[] read seam')
    return {
      sessionCount: missing,
      blankTurns: missing,
      officialUsage: missing,
    }
  }
  const sessionCount = extractSessionCount(listValue)
  const item = items.find((candidate) => matchesSeededSession(candidate, sessionId))
  if (!item) {
    const missing = unavailableRead('seeded session not present in session.list items')
    return {
      sessionCount,
      blankTurns: missing,
      officialUsage: missing,
    }
  }
  return {
    sessionCount,
    blankTurns: extractBlankTurns(item),
    officialUsage: extractOfficialUsage(item),
  }
}

export function detectStartSignals(posted) {
  const error = posted?.error ?? posted
  const code = error?.code
  const structured = sanitizeProviderFailureCode(error?.failure?.code)
  const parenthesized = sanitizeProviderFailureCode(extractParenthesizedUpperCode(error?.message ?? posted?.message))
  const providerFailureCode = structured !== 'UNKNOWN' ? structured : parenthesized
  return {
    errorCode: code === 'INFERENCE_UNAVAILABLE' ? 'INFERENCE_UNAVAILABLE' : (code ? 'other' : 'absent'),
    providerFailureCode,
    missingCredential: providerFailureCode === 'MISSING_CREDENTIAL',
  }
}

export function inspectDiySurface(html) {
  const text = String(html ?? '')
  const methods = Object.fromEntries(T7_DIY_METHODS.map((method) => [method, hasDiyMethodToken(text, method)]))
  return {
    present: text.includes('window.CLARIFY_REMOTE') && text.includes('/api/'),
    createsSession: hasSessionCreateInvocation(text),
    methods,
  }
}

export function observeSeekTtyInstalled(dumpText) {
  if (typeof dumpText !== 'string' || dumpText.trim() === '') {
    return { proven: false, installed: undefined }
  }
  return {
    proven: true,
    installed: /seektty/i.test(dumpText),
  }
}

export function assertExactDshVersion(observed, expected) {
  const got = String(observed ?? '').trim()
  if (got !== expected) {
    throw new Error(`阻塞：dsh --version must equal ${expected}`)
  }
  return got
}

export function verifyReleaseChecksum(bytes, sumsText, assetName) {
  const actual = createHash('sha256').update(bytes).digest('hex').toLowerCase()
  const lines = String(sumsText ?? '').split('\n')
  for (const line of lines) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/)
    if (!match) continue
    const name = match[2].split('/').pop()
    if (name === assetName) {
      return { checksumVerified: actual === match[1].toLowerCase() }
    }
  }
  return { checksumVerified: false }
}

export function officialWorkspaceId(value) {
  if (typeof value?.workspaceId === 'string' && value.workspaceId.trim()) return value.workspaceId.trim()
  return undefined
}

export function officialSessionId(value) {
  if (typeof value?.sessionId === 'string' && value.sessionId.trim()) return value.sessionId.trim()
  return undefined
}

export function resolveT7Assets(parsed, io = { readFileSync, basename: nodeBasename }) {
  if (parsed?.mode === 'from-pack') {
    return {
      mode: 'from-pack',
      checksumVerified: false,
      userValue: false,
      clarifyRelease: T7_CLARIFY_RELEASE,
    }
  }
  try {
    requireFromReleaseAssets(parsed)
    const clarifyName = io.basename(parsed.clarifyTgz)
    const auxiliaryName = io.basename(parsed.auxiliaryTgz)
    const clarifyBytes = io.readFileSync(parsed.clarifyTgz)
    const clarifySums = io.readFileSync(parsed.clarifySums, 'utf8')
    const auxiliaryBytes = io.readFileSync(parsed.auxiliaryTgz)
    const auxiliarySums = io.readFileSync(parsed.auxiliarySums, 'utf8')
    const namesMatchKnownVersions = clarifyName === T7_CLARIFY_TGZ_NAME
      && auxiliaryName === T7_AUXILIARY_TGZ_NAME
    const checksumVerified = namesMatchKnownVersions
      && verifyReleaseChecksum(clarifyBytes, clarifySums, clarifyName).checksumVerified
      && verifyReleaseChecksum(auxiliaryBytes, auxiliarySums, auxiliaryName).checksumVerified
    return {
      mode: 'from-release',
      checksumVerified,
      userValue: checksumVerified,
      clarifyRelease: parsed.clarifyRelease,
      auxiliaryRelease: parsed.auxiliaryRelease,
    }
  } catch (error) {
    throw wrapAssetReadError(error)
  }
}

export async function seedOfficialPublicSession(postApi, origin, options = {}) {
  const workspacePath = options.workspacePath ?? createIsolatedWorkspacePath(options.home)
  const created = await postApi(origin, 'workspace.create', { path: workspacePath })
  const workspaceId = officialWorkspaceId(created?.value)
  const sessionPayload = workspaceId ? { workspaceId } : { cwd: workspacePath }
  const result = await postApi(origin, 'session.create', sessionPayload)
  const sessionId = officialSessionId(result?.value)
  if (sessionId) {
    return {
      sessionId,
      seeded: true,
      label: labelOfficialPublicSession({ createdByThisScript: true }),
    }
  }
  return {
    seeded: false,
    label: labelOfficialPublicSession({ createdByThisScript: false }),
    reason: 'official public workspace.create({path}) / session.create did not seed a session',
  }
}

export async function takePublicSnapshot(postApi, origin, sessionId) {
  const listed = await postApi(origin, 'session.list', {})
  return snapshotFromSessionList(listed?.value, sessionId)
}

function hasSessionCreateInvocation(text) {
  return /(?:['"`]session\.create['"`]|\/api\/session\/create\b|session\.create\s*\()/i.test(text)
}

function hasDiyMethodToken(text, method) {
  if (method === 'fetchDraft') {
    return (text.includes('id="fetch"') || text.includes("getElementById('fetch')"))
      && (text.includes('fetchDraft') || text.includes('clarify/fetchDraft') || text.includes("clarify('fetchDraft'"))
  }
  return text.includes(`id="${method}"`)
    || text.includes(`getElementById('${method}')`)
    || text.includes(`clarify/${method}`)
    || text.includes(`clarify('${method}'`)
}

function extractParenthesizedUpperCode(message) {
  const matches = [...String(message ?? '').matchAll(/\(([A-Z][A-Z0-9_]{1,32})\)/g)]
  if (matches.length === 0) return ''
  return matches[matches.length - 1][1]
}

function sanitizeProviderFailureCode(code) {
  if (typeof code !== 'string') return 'UNKNOWN'
  const trimmed = code.trim()
  if (!/^[A-Z][A-Z0-9_]{1,32}$/.test(trimmed)) return 'UNKNOWN'
  return trimmed
}

function listedIdValues(ids) {
  return (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id.length > 0)
}

function exactOnboardingMatches(buttons, labels) {
  const names = []
  for (const node of Array.isArray(buttons) ? buttons : []) {
    const name = typeof node === 'string'
      ? node.trim()
      : (node && node.visible !== false ? String(node.name ?? node.ariaLabel ?? node.text ?? '').trim() : '')
    if (name && labels.includes(name)) names.push(name)
  }
  return names
}

function matchesSeededSession(item, sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && officialSessionId(item) === sessionId
}

function blankTurnsFromValues(values) {
  const blank = values?.sessionListMetadata?.blank
  const turns = values?.sessionStats?.turns
  if (typeof blank !== 'boolean' || typeof turns !== 'number' || !Number.isFinite(turns)) return undefined
  return {
    available: true,
    status: 'observed',
    blank,
    hasTurns: turns > 0,
  }
}

function officialUsageFromBuckets(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const nums = ['totalTokens', 'uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'inputTokens']
    .map((key) => usage[key])
    .filter((item) => typeof item === 'number' && Number.isFinite(item))
  if (nums.length === 0) return undefined
  return {
    available: true,
    status: 'observed',
    band: nums.some((item) => item > 0) ? 'nonzero' : usageBand(0),
  }
}

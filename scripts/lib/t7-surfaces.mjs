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

export function listedSessionItems(value) {
  return Array.isArray(value?.items) ? value.items : null
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

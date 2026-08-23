import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clarifyDiyHtml } from '../src/host-diy.ts'
import {
  T7_AUXILIARY_RELEASE,
  T7_AUXILIARY_TGZ_NAME,
  T7_CLARIFY_RELEASE,
  T7_CLARIFY_TGZ_NAME,
  T7_COUNT_BANDS,
  T7_PROTOCOL,
  T7_REQUIRED_COMPARISON_KEYS,
  T7_USAGE_BANDS,
  buildT7Document,
  classifyAssetProvenance,
  classifyT7,
  comparePublicObservation,
  countBand,
  evaluateTrackedT7,
  formatT7Report,
  isFullT7,
  isG0Pass,
  isUserValueEvidence,
  parseT7LabArgs,
  requireFromReleaseAssets,
  sanitizeT7Document,
  unavailableRead,
  usageBand,
  validateT7Document,
  validateT7Structure,
} from '../scripts/lib/t7-schema.mjs'
import {
  assertExactDshVersion,
  detectStartSignals,
  extractBlankTurns,
  extractOfficialUsage,
  extractSessionCount,
  OFFICIAL_ONBOARDING_LATER_LABELS,
  OFFICIAL_ONBOARDING_SAVE_LABELS,
  OFFICIAL_WELCOME_LABELS,
  inspectDiySurface,
  isWritableComposerTextarea,
  labelOfficialPublicSession,
  listSessionIds,
  planOfficialOnboardingAction,
  observeSeekTtyInstalled,
  officialSessionId,
  officialWorkspaceId,
  resolveT7Assets,
  seedOfficialPublicSession,
  sessionListDelta,
  snapshotFromSessionList,
  snapshotImmediateBeforeFirstClarifyRpc,
  stripProviderKeys,
  takePublicSnapshot,
  verifyReleaseChecksum,
} from '../scripts/lib/t7-surfaces.mjs'
import { PINNED_DSH_VERSION } from '../scripts/lib/versions.mjs'
import { FROZEN_G0_EVIDENCE } from '../scripts/t7-live.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const G0_JSON = join(root, 'docs/t7-evidence/0.1.1-rc.2/t7.json')
const G0_REPORT = join(root, 'docs/t7-evidence/0.1.1-rc.2/t7-report.md')
const FULL_JSON = join(root, 'docs/t7-evidence/0.1.1-rc.2/t7-full.json')
const FULL_REPORT = join(root, 'docs/t7-evidence/0.1.1-rc.2/t7-full-report.md')
const FROZEN_G0_JSON_SHA256 = '45be6bf76ce1a48fd69a2d2dbcb391c356d8db9cdd30b94c5fbeaa3c0148817e'
const FROZEN_G0_REPORT_SHA256 = 'd49ec0e8b5a7e49ac03d067c53b5df6c884dfc3ce5122388ea803623feed6878'
const PREWRITE_FULL_JSON_SHA256 = 'f50942d356bb6f9c793c178f77ce9e0c2d2bca2f04ac12735cc3650bec6a503e'
const PREWRITE_FULL_REPORT_SHA256 = '15b3abcadb1b0bde4049b77b24e505da75aab4b507e70a9c4073ec8a82150ec7'

function trackedEvidence() {
  return JSON.parse(readFileSync(G0_JSON, 'utf8'))
}

function sha256File(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function observedCount(band: 'zero' | 'one' | 'many') {
  return { available: true, status: 'observed', band }
}

function observedBlankTurns(blank = true, hasTurns = false) {
  return { available: true, status: 'observed', blank, hasTurns }
}

function observedUsage(band: 'zero' | 'nonzero' = 'zero') {
  return { available: true, status: 'observed', band }
}

function listedItem(sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId,
    projections: {
      values: {
        sessionListMetadata: { blank: true },
        sessionStats: { turns: 0 },
        tokenUsage: {
          uncachedInputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
    },
    ...extra,
  }
}

function topLevelListedItem(sessionId: string) {
  return {
    sessionId,
    sessionListMetadata: { blank: true },
    sessionStats: { turns: 0 },
    tokenUsage: {
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  }
}

function g0Observation(overrides: Record<string, unknown> = {}) {
  return {
    hostVersion: '0.1.1-rc.2',
    clarifyVersion: '0.2.2',
    gate: 'G0',
    noKey: true,
    mock: false,
    seekTtyInstalled: false,
    seekTtyProven: true,
    recommendedJointBaseline: false,
    webOnlyComplete: false,
    draftManuallyPasted: false,
    userSent: false,
    pluginAutoSent: false,
    asset: {
      mode: 'from-release',
      checksumVerified: true,
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    },
    session: labelOfficialPublicSession({ createdByThisScript: true }),
    preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
      sessionCount: observedCount('many'),
      blankTurns: observedBlankTurns(),
      officialUsage: observedUsage(),
    }),
    start: detectStartSignals({
      ok: false,
      error: {
        code: 'INFERENCE_UNAVAILABLE',
        category: 'retryable',
        message: 'auxiliary model call did not succeed (ENOTSUP)',
      },
    }),
    postCallSnapshot: {
      sessionCount: observedCount('many'),
      blankTurns: observedBlankTurns(),
      officialUsage: observedUsage(),
    },
    diy: inspectDiySurface(clarifyDiyHtml()),
    ...overrides,
  }
}

function honestPollutionProbes() {
  return {
    source: 'contract',
    window: 'clarify-only',
    transcript: 'unavailable',
    queue: 'unavailable',
    pending: 'unavailable',
    plan: 'unavailable',
    goal: 'unavailable',
  }
}

function forgedPublicPollutionProbes() {
  return {
    source: 'public',
    transcript: 'unchanged',
    queue: 'unchanged',
    pending: 'unchanged',
    plan: 'unchanged',
    goal: 'unchanged',
  }
}

function observedPostCallSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionCount: observedCount('many'),
    blankTurns: observedBlankTurns(),
    officialUsage: observedUsage(),
    beforeOfficialSend: true,
    ...overrides,
  }
}

function observedPostSendSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sessionCount: observedCount('many'),
    blankTurns: observedBlankTurns(false, true),
    officialUsage: observedUsage('zero'),
    afterOfficialSend: true,
    ...overrides,
  }
}

function fullJourneyObservation(overrides: Record<string, unknown> = {}) {
  return g0Observation({
    gate: 'T7',
    noKey: false,
    mock: false,
    webOnlyComplete: true,
    draftManuallyPasted: true,
    userSent: true,
    postCallSnapshot: observedPostCallSnapshot(),
    diyJourney: {
      surface: 'host-diy',
      ok: true,
      methods: {
        start: 'succeeded',
        answer: 'succeeded',
        accept: 'succeeded',
        refine: 'succeeded',
        cancel: 'succeeded',
        fetchDraft: 'succeeded',
      },
    },
    manualDraftTransfer: { observed: true, method: 'manual-paste', autoFilled: false },
    officialComposerSend: { observed: true, channel: 'official-web-composer' },
    cancelRecovery: { observed: true, cancelled: true, recovered: true },
    pollutionProbes: honestPollutionProbes(),
    postSendSnapshot: observedPostSendSnapshot(),
    ...overrides,
  })
}

describe('t7/1 schema', () => {
  it('uses protocol t7/1 and coarse bands only', () => {
    expect(T7_PROTOCOL).toBe('t7/1')
    expect(usageBand(0)).toBe('zero')
    expect(usageBand(12)).toBe('nonzero')
    expect(usageBand(undefined)).toBe('unavailable')
    expect(countBand(0)).toBe('zero')
    expect(countBand(1)).toBe('one')
    expect(countBand(3)).toBe('many')
  })

  it('marks an absent public read seam unavailable without fabricated equality or hash', () => {
    const probe = unavailableRead('no public session.transcript read seam')
    expect(probe).toEqual({
      available: false,
      status: 'unavailable',
      reason: 'no public session.transcript read seam',
    })
    expect(probe).not.toHaveProperty('equal')
    expect(probe).not.toHaveProperty('equals')
    expect(probe).not.toHaveProperty('hash')
    expect(probe).not.toHaveProperty('digest')
    expect(probe).not.toHaveProperty('unchanged')
    expect(comparePublicObservation(probe, probe)).toEqual({
      available: false,
      status: 'unavailable',
    })
  })

  it('compares observed public bands without emitting raw integers', () => {
    const before = observedUsage('zero')
    const same = comparePublicObservation(before, { ...before })
    const changed = comparePublicObservation(before, observedUsage('nonzero'))
    expect(same).toEqual({ available: true, status: 'observed', unchanged: true })
    expect(changed).toEqual({ available: true, status: 'observed', unchanged: false })
    expect(JSON.stringify(same)).not.toMatch(/\d/)
  })

  it('treats only checksum-verified from-release assets as user-value evidence', () => {
    expect(classifyAssetProvenance({ mode: 'from-pack' })).toEqual({
      mode: 'from-pack',
      checksumVerified: false,
      userValue: false,
    })
    expect(classifyAssetProvenance({ mode: 'from-release', checksumVerified: false })).toMatchObject({
      userValue: false,
    })
    expect(isUserValueEvidence(classifyAssetProvenance({ mode: 'from-release', checksumVerified: true }))).toBe(true)
    expect(isUserValueEvidence(classifyAssetProvenance({ mode: 'from-pack', checksumVerified: true }))).toBe(false)
  })

  it('never lets no-key or mocks equal full T7', () => {
    const g0 = buildT7Document(g0Observation())
    expect(g0.protocol).toBe('t7/1')
    expect(isG0Pass(g0)).toBe(true)
    expect(isFullT7(g0)).toBe(false)
    expect(classifyT7(g0)).toMatchObject({ gate: 'G0', fullT7: false, noKey: true })
    expect(isFullT7(buildT7Document(g0Observation({
      noKey: false,
      mock: true,
      webOnlyComplete: true,
      draftManuallyPasted: true,
      userSent: true,
    })))).toBe(false)
    expect(isFullT7(buildT7Document(g0Observation({
      gate: 'T7',
      noKey: false,
      asset: { mode: 'from-pack', checksumVerified: false },
      webOnlyComplete: true,
      draftManuallyPasted: true,
      userSent: true,
    })))).toBe(false)
  })

  it('rejects claimed available or unchanged readings when pre/post are unavailable or inconsistent', () => {
    const claimed = {
      ...buildT7Document(g0Observation()),
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: unavailableRead('no list'),
        blankTurns: unavailableRead('missing blank'),
        officialUsage: unavailableRead('missing tokenUsage'),
      }),
      postCallSnapshot: {
        sessionCount: unavailableRead('no list'),
        blankTurns: unavailableRead('missing blank'),
        officialUsage: unavailableRead('missing tokenUsage'),
      },
      comparisons: {
        sessionCount: 'unchanged',
        blankTurns: 'unchanged',
        officialUsage: 'unchanged',
      },
    }
    const checked = validateT7Document(claimed)
    expect(checked.ok).toBe(false)
    expect(checked.errors.join(' ')).toMatch(/unchanged|unavailable|pre\/post/)
    expect(isG0Pass(claimed)).toBe(false)
    expect(isG0Pass(buildT7Document(g0Observation({
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: unavailableRead('no list'),
        blankTurns: observedBlankTurns(),
        officialUsage: observedUsage(),
      }),
    })))).toBe(false)
  })

  it('requires evidence-backed six-method DIY, manual transfer, composer send, cancel/recovery, and pollution probes for full T7', () => {
    expect(isFullT7(buildT7Document(g0Observation({
      noKey: false,
      webOnlyComplete: true,
      draftManuallyPasted: true,
      userSent: true,
    })))).toBe(false)
    const full = buildT7Document(fullJourneyObservation())
    expect(isFullT7(full)).toBe(true)
    expect(full.pollutionProbes).toEqual(honestPollutionProbes())
    expect(full.postCallSnapshot).toMatchObject({ beforeOfficialSend: true })
    expect(full.postSendSnapshot).toMatchObject({ afterOfficialSend: true })
    expect(full.sendComparisons).toEqual({
      sessionCount: 'unchanged',
      blankTurns: 'changed',
      officialUsage: 'unchanged',
    })
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      diyJourney: { surface: 'host-diy', ok: true, methods: { start: 'succeeded' } },
    })))).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      pollutionProbes: { source: 'claimed-boolean', transcript: 'unchanged' },
    })))).toBe(false)
  })

  it('requires official public session labels and an immediate pre-call snapshot', () => {
    const labeled = labelOfficialPublicSession({ createdByThisScript: true })
    expect(labeled).toEqual({
      source: 'official-public-remote',
      productionPluginCreated: false,
      createdByThisScript: true,
    })
    const snapshot = snapshotImmediateBeforeFirstClarifyRpc({ ready: true })
    expect(snapshot.immediate).toBe(true)
    expect(snapshot.beforeFirstClarifyRpc).toBe(true)
    const missingSnapshot = validateT7Document(buildT7Document(g0Observation({
      preCallSnapshot: { sessionCount: observedCount('many') },
    })))
    expect(missingSnapshot.ok).toBe(false)
    expect(missingSnapshot.errors.join(' ')).toMatch(/immediate|beforeFirstClarifyRpc/)
  })

  it('rejects documents that still carry raw usage, sessionId, or prompt text', () => {
    const dirty = sanitizeT7Document({
      ...buildT7Document(g0Observation()),
      sessionId: 'sess-1',
      seedText: 'write a login form',
      totalTokens: 8,
    })
    expect(dirty).not.toHaveProperty('sessionId')
    expect(dirty).not.toHaveProperty('seedText')
    expect(dirty).not.toHaveProperty('totalTokens')
    const invalid = validateT7Document({
      ...buildT7Document(g0Observation()),
      sessionId: 'sess-1',
      comparisons: { sessionCount: 'unchanged', blankTurns: 'unchanged', officialUsage: 12 },
    })
    expect(invalid.ok).toBe(false)
  })
})

describe('t7 public surfaces', () => {
  it('derives blank/turns and official usage only from the seeded session.list item projections', () => {
    const listed = {
      items: [
        listedItem('seeded-target'),
        listedItem('stock-web-extra'),
      ],
    }
    const snapshot = snapshotFromSessionList(listed, 'seeded-target')
    expect(snapshot.sessionCount).toEqual({ available: true, status: 'observed', band: 'many' })
    expect(snapshot.blankTurns).toEqual({ available: true, status: 'observed', blank: true, hasTurns: false })
    expect(snapshot.officialUsage).toEqual({ available: true, status: 'observed', band: 'zero' })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toMatch(/seeded-target|stock-web-extra|sessionId|uncachedInputTokens|"turns":0/)
    expect(extractSessionCount(listed).band).toBe('many')
    expect(listedItem('seeded-target')).not.toHaveProperty('sessionStats')
    expect(listedItem('seeded-target')).not.toHaveProperty('tokenUsage')
    expect(listedItem('seeded-target').projections.values).toHaveProperty('sessionStats')
    expect(listedItem('seeded-target').projections.values).toHaveProperty('tokenUsage')
    expect(extractBlankTurns(listedItem('seeded-target', {
      projections: {
        values: {
          sessionListMetadata: { blank: false },
          sessionStats: { turns: 2 },
          tokenUsage: { outputTokens: 0 },
        },
      },
    }))).toEqual({ available: true, status: 'observed', blank: false, hasTurns: true })
    expect(extractOfficialUsage(listedItem('seeded-target', {
      projections: {
        values: {
          sessionListMetadata: { blank: true },
          sessionStats: { turns: 0 },
          tokenUsage: { outputTokens: 4 },
        },
      },
    })).band).toBe('nonzero')
    expect(JSON.stringify(extractOfficialUsage(listedItem('seeded-target', {
      projections: {
        values: {
          sessionListMetadata: { blank: true },
          sessionStats: { turns: 0 },
          tokenUsage: { outputTokens: 4 },
        },
      },
    })))).not.toMatch(/4/)
  })

  it('does not treat top-level sessionStats/tokenUsage as the rc.2 oracle', () => {
    expect(extractBlankTurns(topLevelListedItem('seeded-target'))).toEqual(
      unavailableRead('session.list item missing projections.values sessionListMetadata.blank or sessionStats.turns'),
    )
    expect(extractOfficialUsage(topLevelListedItem('seeded-target'))).toEqual(
      unavailableRead('session.list item missing projections.values tokenUsage'),
    )
    expect(extractBlankTurns(topLevelListedItem('seeded-target'), { allowFallback: true })).toEqual({
      available: true,
      status: 'observed',
      blank: true,
      hasTurns: false,
    })
    expect(extractOfficialUsage(topLevelListedItem('seeded-target'), { allowFallback: true }).band).toBe('zero')
  })

  it('records unavailable and blocks G0 when a required list projection is absent', () => {
    const missing = snapshotFromSessionList({
      items: [{ sessionId: 'seeded-target' }, { sessionId: 'stock-web-extra' }],
    }, 'seeded-target')
    expect(missing.sessionCount.band).toBe('many')
    expect(missing.blankTurns).toEqual(unavailableRead('session.list item missing projections.values sessionListMetadata.blank or sessionStats.turns'))
    expect(missing.officialUsage).toEqual(unavailableRead('session.list item missing projections.values tokenUsage'))
    expect(isG0Pass(buildT7Document(g0Observation({
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc(missing),
      postCallSnapshot: missing,
    })))).toBe(false)
    expect(extractBlankTurns({ messages: [], turns: [] })).toEqual(
      unavailableRead('session.list item missing projections.values sessionListMetadata.blank or sessionStats.turns'),
    )
    expect(extractOfficialUsage({ hello: true })).toEqual(
      unavailableRead('session.list item missing projections.values tokenUsage'),
    )
  })

  it('snapshots only through session.list and never calls session.get or session.current', async () => {
    const methods: string[] = []
    const postApi = async (_origin: string, method: string) => {
      methods.push(method)
      return {
        ok: true,
        value: { items: [listedItem('seeded-target'), listedItem('stock-web-extra')] },
      }
    }
    const snapshot = await takePublicSnapshot(postApi, 'http://127.0.0.1:1', 'seeded-target')
    expect(methods).toEqual(['session.list'])
    expect(snapshot.sessionCount.band).toBe('many')
    const source = readFileSync(join(root, 'scripts/lib/t7-surfaces.mjs'), 'utf8')
    expect(source).not.toMatch(/session\.get|session\.current/)
  })

  it('takes a unique session.list id only from an empty-to-one delta', () => {
    expect(listSessionIds({ items: [] })).toEqual([])
    expect(listSessionIds({ items: [{ sessionId: 'sess-1' }, { sessionId: 'sess-2' }] })).toEqual(['sess-1', 'sess-2'])
    expect(listSessionIds({ items: [{ id: 'sess-1' }] })).toEqual([])
    expect(listSessionIds({})).toEqual([])
    expect(sessionListDelta([], ['sess-1'])).toEqual({ ok: true, id: 'sess-1' })
    expect(sessionListDelta([], [])).toMatchObject({ ok: false, code: 'SESSION_DELTA', category: 'environment' })
    expect(sessionListDelta([], ['a', 'b'])).toMatchObject({ ok: false, code: 'SESSION_DELTA' })
    expect(sessionListDelta(['a'], ['a', 'b'])).toMatchObject({ ok: false, code: 'SESSION_DELTA' })
    expect(sessionListDelta(['a'], ['a'])).toMatchObject({ ok: false, code: 'SESSION_DELTA' })
  })

  it('requires textarea visibility and refuses Save and continue as a welcome control', () => {
    expect(isWritableComposerTextarea({
      tag: 'textarea',
      disabled: false,
      readOnly: false,
      dataPhase: 'plain',
      ariaLabel: '',
      visible: true,
    })).toBe(true)
    expect(isWritableComposerTextarea({
      tag: 'textarea',
      disabled: false,
      readOnly: false,
      dataPhase: 'plain',
      ariaLabel: '',
      visible: false,
    })).toBe(false)
    expect(OFFICIAL_WELCOME_LABELS).toEqual(['Continue', '继续'])
    expect(OFFICIAL_ONBOARDING_LATER_LABELS).toEqual(['Configure later', '稍后配置'])
    expect(OFFICIAL_ONBOARDING_SAVE_LABELS).toEqual(['Save and continue', '保存并继续'])
    expect(planOfficialOnboardingAction({
      buttons: [{ name: 'Save and continue', visible: true }],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED' })
  })

  it('seeds with workspace.create({path}) then session.create(workspaceId or cwd)', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const postApi = async (_origin: string, method: string, payload: unknown) => {
      calls.push({ method, payload })
      if (method === 'workspace.create') return { ok: true, value: { workspaceId: 'ws-1' } }
      if (method === 'session.create') return { ok: true, value: { sessionId: 'seeded-target' } }
      return { ok: false }
    }
    const seeded = await seedOfficialPublicSession(postApi, 'http://127.0.0.1:1', {
      workspacePath: '/tmp/clarify-isolated-workspace',
    })
    expect(seeded).toMatchObject({
      seeded: true,
      label: {
        source: 'official-public-remote',
        productionPluginCreated: false,
        createdByThisScript: true,
      },
    })
    expect(calls).toEqual([
      { method: 'workspace.create', payload: { path: '/tmp/clarify-isolated-workspace' } },
      { method: 'session.create', payload: { workspaceId: 'ws-1' } },
    ])
    const cwdCalls: Array<unknown> = []
    await seedOfficialPublicSession(async (_origin, method, payload) => {
      cwdCalls.push({ method, payload })
      if (method === 'workspace.create') return { ok: true, value: {} }
      if (method === 'session.create') return { ok: true, value: { sessionId: 'seeded-cwd' } }
      return { ok: false }
    }, 'http://127.0.0.1:1', { workspacePath: '/tmp/clarify-isolated-workspace' })
    expect(cwdCalls).toEqual([
      { method: 'workspace.create', payload: { path: '/tmp/clarify-isolated-workspace' } },
      { method: 'session.create', payload: { cwd: '/tmp/clarify-isolated-workspace' } },
    ])
  })

  it('strips provider keys without reading or printing their values', () => {
    const env = { KEEP: 'yes', OPENAI_API_KEY: 'sk-secret', DEEPSEEK_API_KEY: 'ds-secret' }
    stripProviderKeys(env)
    expect(env).toEqual({ KEEP: 'yes' })
    const source = [
      readFileSync(join(root, 'scripts/lib/t7-surfaces.mjs'), 'utf8'),
      readFileSync(join(root, 'scripts/t7-lab.mjs'), 'utf8'),
    ].join('\n')
    expect(source).toMatch(/delete\s+\w+\.OPENAI_API_KEY/)
    expect(source).toMatch(/delete\s+\w+\.DEEPSEEK_API_KEY/)
    expect(source).not.toMatch(/console\.[a-z]+\([^)]*(OPENAI_API_KEY|DEEPSEEK_API_KEY)/)
    expect(source).not.toMatch(/process\.env\.(OPENAI_API_KEY|DEEPSEEK_API_KEY)/)
  })

  it('detects G0 no-key start and distinguishes DIY session.create invocation from prose', () => {
    expect(detectStartSignals({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', message: 'auxiliary model call did not succeed (ENOTSUP)', category: 'retryable' },
    })).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
      missingCredential: false,
    })
    expect(inspectDiySurface('<html>window.CLARIFY_REMOTE /api/clarify This page never creates a Session. Bind session.create as an existing id.</html>')).toMatchObject({
      createsSession: false,
    })
    expect(inspectDiySurface("<script>await post('/api/session/create', body)</script>")).toMatchObject({
      createsSession: true,
    })
    expect(inspectDiySurface("call('session.create')")).toMatchObject({
      createsSession: true,
    })
  })

  it('verifies published SHA256SUMS without keeping the digest in the result', () => {
    const bytes = Buffer.from('clarify-release-bytes')
    const actual = createHash('sha256').update(bytes).digest('hex')
    const sums = `${actual}  dsh-plugin-clarify-0.2.2.tgz\n`
    const verified = verifyReleaseChecksum(bytes, sums, 'dsh-plugin-clarify-0.2.2.tgz')
    expect(verified).toEqual({ checksumVerified: true })
    expect(verified).not.toHaveProperty('sha256')
    expect(verified).not.toHaveProperty('digest')
    expect(verifyReleaseChecksum(bytes, 'abcd  other.tgz\n', 'dsh-plugin-clarify-0.2.2.tgz')).toEqual({
      checksumVerified: false,
    })
  })
})

describe('t7 lab argv', () => {
  it('accepts --validate, --from-pack, and --from-release without inventing a mode', () => {
    expect(parseT7LabArgs(['--validate'])).toMatchObject({ mode: 'validate', userValue: false })
    expect(parseT7LabArgs(['--from-pack'])).toMatchObject({ mode: 'from-pack', userValue: false })
    expect(parseT7LabArgs(['--from-release', '--dsh-version', '0.1.1-rc.2'])).toMatchObject({
      mode: 'from-release',
      dshVersion: '0.1.1-rc.2',
      requireLocalAssets: true,
    })
    expect(() => parseT7LabArgs([])).toThrow(/--validate|--from-pack|--from-release/)
    expect(() => requireFromReleaseAssets(parseT7LabArgs(['--from-release']))).toThrow(/tgz|SHA256SUMS|阻塞/)
  })

  it('rejects a path-shaped Host or 0.1.0-rc.8 before T7 builds any evidence or install path', () => {
    expect(parseT7LabArgs(['--validate']).dshVersion).toBe(PINNED_DSH_VERSION)
    expect(parseT7LabArgs(['--from-pack']).dshVersion).toBe(PINNED_DSH_VERSION)
    expect(() => parseT7LabArgs(['--validate', '--dsh-version', `..${sep}src`])).toThrow(/0\.1\.1-rc\.2/)
    expect(() => parseT7LabArgs(['--from-pack', '--dsh-version', `..${sep}src`])).toThrow(/0\.1\.1-rc\.2/)
    expect(() => parseT7LabArgs(['--from-release', '--dsh-version', '0.1.0-rc.8'])).toThrow(/0\.1\.1-rc\.2/)
    expect(parseT7LabArgs(['--from-release', '--dsh-version', PINNED_DSH_VERSION]).dshVersion).toBe(PINNED_DSH_VERSION)
  })
})

describe('t7 evidence integrity adversarial', () => {
  it('rejects empty or extra comparison maps and shapeless observed snapshots', () => {
    expect([...T7_REQUIRED_COMPARISON_KEYS]).toEqual(['sessionCount', 'blankTurns', 'officialUsage'])
    expect(T7_COUNT_BANDS.has('one')).toBe(true)
    expect(T7_USAGE_BANDS.has('nonzero')).toBe(true)
    const honest = buildT7Document(g0Observation())
    expect(validateT7Document({ ...honest, comparisons: {} }).ok).toBe(false)
    expect(validateT7Document({
      ...honest,
      comparisons: { sessionCount: 'unchanged', blankTurns: 'unchanged' },
    }).ok).toBe(false)
    expect(validateT7Document({
      ...honest,
      comparisons: {
        sessionCount: 'unchanged',
        blankTurns: 'unchanged',
        officialUsage: 'unchanged',
        transcript: 'unchanged',
      },
    }).ok).toBe(false)
    const shapeless = {
      available: true,
      status: 'observed',
    }
    const fabricated = buildT7Document(fullJourneyObservation({
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: shapeless,
        blankTurns: shapeless,
        officialUsage: shapeless,
      }),
      postCallSnapshot: {
        sessionCount: shapeless,
        blankTurns: shapeless,
        officialUsage: shapeless,
      },
    }))
    expect(validateT7Document(fabricated).ok).toBe(false)
    expect(isFullT7(fabricated)).toBe(false)
    expect(validateT7Document({
      ...honest,
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: { available: true, status: 'observed', band: 'nonzero' },
        blankTurns: observedBlankTurns(),
        officialUsage: observedUsage(),
      }),
    }).ok).toBe(false)
    expect(validateT7Document({
      ...honest,
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: observedCount('many'),
        blankTurns: { available: true, status: 'observed' },
        officialUsage: observedUsage(),
      }),
    }).ok).toBe(false)
    expect(validateT7Document({
      ...honest,
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: observedCount('many'),
        blankTurns: observedBlankTurns(),
        officialUsage: { available: true, status: 'observed', band: 'one' },
      }),
    }).ok).toBe(false)
    expect(validateT7Document({
      ...honest,
      preCallSnapshot: snapshotImmediateBeforeFirstClarifyRpc({
        sessionCount: { available: false, status: 'unavailable', band: 'many' },
        blankTurns: unavailableRead('x'),
        officialUsage: unavailableRead('y'),
      }),
      comparisons: {
        sessionCount: 'unavailable',
        blankTurns: 'unavailable',
        officialUsage: 'unavailable',
      },
    }).ok).toBe(false)
  })

  it('requires explicit T7 flags and rejects undefined full-T7 claims', () => {
    const full = buildT7Document(fullJourneyObservation())
    expect(full.gate).toBe('T7')
    expect(isFullT7(full)).toBe(true)
    expect(isFullT7({ ...full, gate: 'G0' })).toBe(false)
    expect(isFullT7({ ...full, webOnlyComplete: undefined })).toBe(false)
    expect(isFullT7({ ...full, draftManuallyPasted: undefined })).toBe(false)
    expect(isFullT7({ ...full, userSent: undefined })).toBe(false)
    expect(isFullT7({ ...full, pluginAutoSent: undefined })).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      webOnlyComplete: false,
    })))).toBe(false)
  })

  it('blocks standalone G0 when the DIY surface is missing or creates a Session', () => {
    const g0 = buildT7Document(g0Observation())
    expect(g0.diy).toMatchObject({ present: true, createsSession: false })
    expect(isG0Pass(g0)).toBe(true)
    expect(isG0Pass({ ...g0, diy: { present: false, createsSession: false } })).toBe(false)
    expect(isG0Pass({ ...g0, diy: undefined })).toBe(false)
    expect(isG0Pass({ ...g0, diy: { present: true, createsSession: true } })).toBe(false)
    expect(isG0Pass(buildT7Document(g0Observation({
      diy: inspectDiySurface('<html>no clarify remote</html>'),
    })))).toBe(false)
  })

  it('rejects derived claim mismatches without recursing through full validation', () => {
    const g0 = buildT7Document(g0Observation())
    expect(validateT7Structure(g0).ok).toBe(true)
    expect(validateT7Document({ ...g0, fullT7: true }).ok).toBe(false)
    expect(validateT7Document({ ...g0, g0Verdict: '阻塞' }).ok).toBe(false)
    const full = buildT7Document(fullJourneyObservation())
    expect(validateT7Document(full).ok).toBe(true)
    expect(validateT7Document({ ...full, fullT7: false }).ok).toBe(false)
    expect(validateT7Document({ ...full, g0Verdict: '通过' }).ok).toBe(false)
    const evaluated = evaluateTrackedT7(full, formatT7Report(full))
    expect(evaluated.ok).toBe(true)
    expect(evaluated.fullT7).toBe(true)
    expect(evaluated.g0).toBe(false)
  })

  it('requires both Clarify and Auxiliary published pairs from known version inputs', () => {
    expect(T7_CLARIFY_RELEASE).toBe('0.2.2')
    expect(T7_AUXILIARY_RELEASE).toBe('0.1.1')
    expect(() => requireFromReleaseAssets(parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'SHA256SUMS',
    ]))).toThrow(/Auxiliary|auxiliary/)
    expect(() => requireFromReleaseAssets(parseT7LabArgs([
      '--from-release',
      '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
    ]))).toThrow(/Clarify|clarify/)
    const halfAndVersions = parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'SHA256SUMS',
      '--clarify-release', '0.2.2',
      '--auxiliary-release', '0.1.1',
    ])
    expect(() => requireFromReleaseAssets(halfAndVersions)).toThrow(/Auxiliary|auxiliary/)
    const parsed = parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'CLARIFY.SUMS',
      '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
      '--clarify-release', '0.2.2',
      '--auxiliary-release', '0.1.1',
    ])
    expect(requireFromReleaseAssets(parsed)).toMatchObject({
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    })
    expect(() => requireFromReleaseAssets(parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'any.tgz',
      '--clarify-sums', 'CLARIFY.SUMS',
      '--auxiliary-tgz', 'other.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
    ]))).toThrow(/0\.2\.2|0\.1\.1|known|clarify-release|auxiliary-release/)
    const files = new Map<string, Buffer | string>([
      ['dsh-plugin-clarify-0.2.2.tgz', Buffer.from('clarify-bytes')],
      ['CLARIFY.SUMS', `${createHash('sha256').update('clarify-bytes').digest('hex')}  dsh-plugin-clarify-0.2.2.tgz\n`],
      ['dsh-plugin-auxiliary-runtime-0.1.1.tgz', Buffer.from('aux-bytes')],
      ['AUX.SUMS', `${createHash('sha256').update('aux-bytes').digest('hex')}  dsh-plugin-auxiliary-runtime-0.1.1.tgz\n`],
    ])
    const io = {
      readFileSync: (path: string, encoding?: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`ENOENT: ${path}`)
        return encoding ? String(value) : value
      },
      basename: (path: string) => path.split('/').pop() ?? path,
    }
    expect(resolveT7Assets(parsed, io)).toMatchObject({
      mode: 'from-release',
      checksumVerified: true,
      userValue: true,
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    })
    expect(resolveT7Assets({
      ...parsed,
      clarifyTgz: 'random.tgz',
    }, {
      ...io,
      readFileSync: (path: string, encoding?: string) => {
        if (path === 'random.tgz') return Buffer.from('clarify-bytes')
        return io.readFileSync(path, encoding)
      },
    }).checksumVerified).not.toBe(true)
    expect(resolveT7Assets(parseT7LabArgs(['--from-pack']))).toMatchObject({
      mode: 'from-pack',
      checksumVerified: false,
      userValue: false,
    })
  })

  it('reports resolve/read asset failures as a clean blocking error without a stack', () => {
    let thrown: unknown
    try {
      resolveT7Assets(parseT7LabArgs([
        '--from-release',
        '--clarify-tgz', 'missing-clarify.tgz',
        '--clarify-sums', 'missing-clarify.SUMS',
        '--auxiliary-tgz', 'missing-aux.tgz',
        '--auxiliary-sums', 'missing-aux.SUMS',
        '--clarify-release', '0.2.2',
        '--auxiliary-release', '0.1.1',
      ]), {
        readFileSync: () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { stack: 'Error: ENOENT\n    at readFileSync (node:fs:1:1)' })
        },
        basename: (path: string) => path,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(/^阻塞：/)
    expect((thrown as Error).message).not.toMatch(/at readFileSync/)
    expect((thrown as Error).message).not.toMatch(/\n\s+at /)
  })

  it('identifies listed items only by sessionId and does not guess workspace/session create ids', async () => {
    const idOnly = snapshotFromSessionList({
      items: [{
        id: 'seeded-target',
        projections: {
          values: {
            sessionListMetadata: { blank: true },
            sessionStats: { turns: 0 },
            tokenUsage: { outputTokens: 0 },
          },
        },
      }],
    }, 'seeded-target')
    expect(idOnly.blankTurns.available).toBe(false)
    expect(idOnly.officialUsage.available).toBe(false)
    expect(officialWorkspaceId({ workspaceId: 'ws-1' })).toBe('ws-1')
    expect(officialWorkspaceId({ id: 'ws-1' })).toBeUndefined()
    expect(officialSessionId({ sessionId: 'seeded-target' })).toBe('seeded-target')
    expect(officialSessionId({ id: 'seeded-target' })).toBeUndefined()
    const guessedWorkspace: Array<{ method: string; payload: unknown }> = []
    const seeded = await seedOfficialPublicSession(async (_origin, method, payload) => {
      guessedWorkspace.push({ method, payload })
      if (method === 'workspace.create') return { ok: true, value: { id: 'ws-1' } }
      if (method === 'session.create') return { ok: true, value: { id: 'seeded-target' } }
      return { ok: false }
    }, 'http://127.0.0.1:1', { workspacePath: '/tmp/clarify-isolated-workspace' })
    expect(guessedWorkspace).toEqual([
      { method: 'workspace.create', payload: { path: '/tmp/clarify-isolated-workspace' } },
      { method: 'session.create', payload: { cwd: '/tmp/clarify-isolated-workspace' } },
    ])
    expect(seeded.seeded).toBe(false)
  })

  it('extracts only a parenthesized or structured provider-neutral failure code and never calls ENOTSUP a credential miss', () => {
    expect(detectStartSignals({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', message: 'auxiliary model call did not succeed (ENOTSUP)', category: 'retryable' },
    })).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
      missingCredential: false,
    })
    expect(detectStartSignals({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', message: 'auxiliary model call did not succeed (MISSING_CREDENTIAL)' },
    })).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'MISSING_CREDENTIAL',
      missingCredential: true,
    })
    expect(detectStartSignals({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', failure: { code: 'MISSING_CREDENTIAL' }, message: 'sanitized' },
    })).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'MISSING_CREDENTIAL',
      missingCredential: true,
    })
    expect(detectStartSignals({
      ok: false,
      error: { code: 'INFERENCE_UNAVAILABLE', message: 'raw unsanitized prose mentioning MISSING_CREDENTIAL' },
    })).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'UNKNOWN',
      missingCredential: false,
    })
    const absent = detectStartSignals({ ok: false, error: { code: 'INFERENCE_UNAVAILABLE' } })
    expect(absent.providerFailureCode).toBe('UNKNOWN')
    expect(JSON.stringify(absent)).not.toMatch(/message|auxiliary model|html/i)
    expect(isG0Pass(buildT7Document(g0Observation({
      start: detectStartSignals({ ok: false, error: { code: 'INFERENCE_UNAVAILABLE' } }),
    })))).toBe(false)
    expect(isG0Pass(buildT7Document(g0Observation({
      start: { errorCode: 'INFERENCE_UNAVAILABLE', providerFailureCode: 'UNKNOWN', missingCredential: false },
    })))).toBe(false)
  })

  it('requires shipped /clarify six-method controls for G0 and does not store HTML', () => {
    const shipped = inspectDiySurface(clarifyDiyHtml())
    expect(shipped).toMatchObject({
      present: true,
      createsSession: false,
      methods: {
        start: true,
        answer: true,
        accept: true,
        refine: true,
        cancel: true,
        fetchDraft: true,
      },
    })
    expect(JSON.stringify(shipped)).not.toMatch(/<!doctype|textarea|seedText/)
    expect(isG0Pass(buildT7Document(g0Observation({
      diy: inspectDiySurface('<html>window.CLARIFY_REMOTE /api/clarify</html>'),
    })))).toBe(false)
    expect(clarifyDiyHtml()).toContain('id="start"')
    expect(clarifyDiyHtml()).toContain('id="fetch"')
    expect(clarifyDiyHtml()).toContain('fetchDraft')
    expect(clarifyDiyHtml()).not.toContain('id="fetchDraft"')
  })

  it('proves SeekTTY absence from official dump text without serializing dump contents', () => {
    expect(observeSeekTtyInstalled('# == dsh-plugin-clarify\n- id: clarify\n')).toEqual({
      proven: true,
      installed: false,
    })
    expect(observeSeekTtyInstalled('# == dsh-plugin-seektty\n- id: seektty\n')).toEqual({
      proven: true,
      installed: true,
    })
    expect(observeSeekTtyInstalled('')).toEqual({ proven: false, installed: undefined })
    const unproven = buildT7Document(g0Observation({ seekTtyProven: false }))
    expect(unproven.seekTtyProven).toBe(false)
    expect(unproven).not.toHaveProperty('seekTtyInstalled')
    expect(isG0Pass(unproven)).toBe(false)
    expect(formatT7Report(unproven)).toMatch(/SeekTTY \| 未知\/未证明/)
    expect(formatT7Report(unproven)).not.toMatch(/SeekTTY \| 未安装/)
    expect(formatT7Report(unproven)).not.toMatch(/SeekTTY \| 已安装/)
    expect(evaluateTrackedT7(unproven, formatT7Report(unproven))).toMatchObject({ ok: true, g0: false })
    expect(validateT7Structure({
      ...buildT7Document(g0Observation()),
      seekTtyProven: false,
      seekTtyInstalled: false,
    }).ok).toBe(false)
    expect(validateT7Structure({
      ...buildT7Document(g0Observation()),
      seekTtyProven: false,
      seekTtyInstalled: true,
    }).ok).toBe(false)
    expect(isG0Pass(buildT7Document(g0Observation({ seekTtyInstalled: true, seekTtyProven: true })))).toBe(false)
    expect(() => assertExactDshVersion('0.1.0-rc.8', '0.1.1-rc.2')).toThrow(/阻塞|0\.1\.1-rc\.2/)
    expect(assertExactDshVersion('0.1.1-rc.2\n', '0.1.1-rc.2')).toBe('0.1.1-rc.2')
  })

  it('requires exact known tgz basenames rather than substring includes', () => {
    expect(T7_CLARIFY_TGZ_NAME).toBe('dsh-plugin-clarify-0.2.2.tgz')
    expect(T7_AUXILIARY_TGZ_NAME).toBe('dsh-plugin-auxiliary-runtime-0.1.1.tgz')
    const parsed = parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'prefix-dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'CLARIFY.SUMS',
      '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
      '--clarify-release', '0.2.2',
      '--auxiliary-release', '0.1.1',
    ])
    const files = new Map<string, Buffer | string>([
      ['prefix-dsh-plugin-clarify-0.2.2.tgz', Buffer.from('clarify-bytes')],
      ['CLARIFY.SUMS', `${createHash('sha256').update('clarify-bytes').digest('hex')}  prefix-dsh-plugin-clarify-0.2.2.tgz\n`],
      ['dsh-plugin-auxiliary-runtime-0.1.1.tgz', Buffer.from('aux-bytes')],
      ['AUX.SUMS', `${createHash('sha256').update('aux-bytes').digest('hex')}  dsh-plugin-auxiliary-runtime-0.1.1.tgz\n`],
    ])
    const io = {
      readFileSync: (path: string, encoding?: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`ENOENT: ${path}`)
        return encoding ? String(value) : value
      },
      basename: (path: string) => path.split('/').pop() ?? path,
    }
    expect(resolveT7Assets(parsed, io).checksumVerified).toBe(false)
  })

  it('describes G0 as INFERENCE_UNAVAILABLE plus providerFailureCode and omits remaining-live copy from a full T7 report', () => {
    const g0 = buildT7Document(g0Observation())
    expect(isG0Pass(g0)).toBe(true)
    expect(g0.start).toMatchObject({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
      missingCredential: false,
    })
    const g0Report = formatT7Report(g0)
    expect(g0Report).toContain('INFERENCE_UNAVAILABLE')
    expect(g0Report).toContain('providerFailureCode=ENOTSUP')
    expect(g0Report).not.toMatch(/MISSING_CREDENTIAL/)
    const fullReport = formatT7Report(buildT7Document(fullJourneyObservation()))
    expect(fullReport).toContain('| 完整 T7 | 是')
    expect(fullReport).toContain('Web-only T7')
    expect(fullReport).toContain('不是 T4 transcript dump')
    expect(fullReport).toContain('不是 T5 stale')
    expect(fullReport).toContain('不是 T6 usage/limits')
    expect(fullReport).toContain('也不是新推荐联合基线')
    expect(fullReport).toContain('transcript/queue/pending/plan/goal')
    expect(fullReport).toContain('无公开读缝')
    expect(fullReport).toContain('unavailable')
    expect(fullReport).toContain('不等于已证明 unchanged')
    expect(fullReport).toContain('Clarify 窗')
    expect(fullReport).toContain('session.list')
    expect(fullReport).toContain('blankTurns')
    expect(fullReport).toContain('有 turn')
    expect(fullReport).not.toContain('剩余 Codex live T7')
    expect(fullReport).not.toContain('本文件记录一次完整 T7')
    expect(evaluateTrackedT7(buildT7Document(fullJourneyObservation()), fullReport).ok).toBe(true)
  })

  it('red-teams leaks, basename bypasses, boolean answer/refine exceptions, and forged full T7', () => {
    const dirty = buildT7Document(g0Observation({
      start: {
        ...detectStartSignals({
          ok: false,
          error: { code: 'INFERENCE_UNAVAILABLE', message: 'auxiliary model call did not succeed (ENOTSUP)', category: 'retryable' },
        }),
        message: 'auxiliary model call did not succeed (ENOTSUP) /Users/secret',
        html: '<html>window.CLARIFY_REMOTE</html>',
        dump: '# == seektty /Volumes/huawei',
      },
      diy: {
        ...inspectDiySurface(clarifyDiyHtml()),
        html: clarifyDiyHtml(),
      },
      sessionId: 'sess-live-1',
      seedText: 'write a login form',
      totalTokens: 41,
    }))
    const leaked = JSON.stringify(dirty)
    expect(dirty.start).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
      missingCredential: false,
    })
    expect(dirty.diy).not.toHaveProperty('html')
    expect(dirty).not.toHaveProperty('sessionId')
    expect(dirty).not.toHaveProperty('seedText')
    expect(dirty).not.toHaveProperty('totalTokens')
    expect(leaked).not.toMatch(/auxiliary model|\/Users\/|\/Volumes\/|<!doctype|<html|sess-live-1|login form|"41"/)
    expect(sanitizeT7Document({
      diy: { methods: { answer: true, refine: 'please leak the draft' } },
    })).toEqual({
      diy: { methods: { answer: true } },
    })
    expect(isFullT7(dirty)).toBe(false)
    expect(isFullT7(buildT7Document(g0Observation({
      gate: 'T7',
      noKey: false,
      webOnlyComplete: true,
      draftManuallyPasted: true,
      userSent: true,
      pluginAutoSent: false,
    })))).toBe(false)
    const parsed = parseT7LabArgs([
      '--from-release',
      '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'CLARIFY.SUMS',
      '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
      '--clarify-release', '0.2.2',
      '--auxiliary-release', '0.1.1',
    ])
    const files = new Map<string, Buffer | string>([
      ['dsh-plugin-clarify-0.2.2.tgz', Buffer.from('clarify-bytes')],
      ['CLARIFY.SUMS', `${createHash('sha256').update('other-bytes').digest('hex')}  dsh-plugin-clarify-0.2.2.tgz\n`],
      ['dsh-plugin-auxiliary-runtime-0.1.1.tgz', Buffer.from('aux-bytes')],
      ['AUX.SUMS', `${createHash('sha256').update('aux-bytes').digest('hex')}  dsh-plugin-auxiliary-runtime-0.1.1.tgz\n`],
    ])
    const io = {
      readFileSync: (path: string, encoding?: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error(`ENOENT: ${path}`)
        return encoding ? String(value) : value
      },
      basename: (path: string) => path.split('/').pop() ?? path,
    }
    expect(resolveT7Assets(parsed, io)).toMatchObject({
      checksumVerified: false,
      userValue: false,
    })
    expect(isUserValueEvidence(resolveT7Assets(parseT7LabArgs(['--from-pack'])))).toBe(false)
  })

  it('rejects old forged public/claimed pollution shapes at structure and fullT7', () => {
    const publicForged = buildT7Document(fullJourneyObservation({
      pollutionProbes: forgedPublicPollutionProbes(),
    }))
    const publicChecked = validateT7Structure(publicForged)
    expect(publicChecked.ok).toBe(false)
    expect(publicChecked.errors.join(' ')).toMatch(/pollutionProbes|source|unavailable/)
    expect(isFullT7(publicForged)).toBe(false)
    const claimed = buildT7Document(fullJourneyObservation({
      pollutionProbes: { source: 'claimed-boolean', transcript: 'unchanged' },
    }))
    expect(validateT7Structure(claimed).ok).toBe(false)
    expect(isFullT7(claimed)).toBe(false)
    const trackedForged = {
      ...trackedEvidence(),
      pollutionProbes: forgedPublicPollutionProbes(),
    }
    expect(validateT7Structure(trackedForged).ok).toBe(false)
    expect(isG0Pass(trackedForged)).toBe(false)
  })

  it('keeps G0 structure pass when live-window fields are absent', () => {
    const g0 = buildT7Document(g0Observation())
    expect(g0).not.toHaveProperty('pollutionProbes')
    expect(g0).not.toHaveProperty('postSendSnapshot')
    expect(g0).not.toHaveProperty('sendComparisons')
    expect(g0.postCallSnapshot).not.toHaveProperty('beforeOfficialSend')
    expect(validateT7Structure(g0).ok).toBe(true)
    expect(validateT7Document(g0).ok).toBe(true)
    expect(isG0Pass(g0)).toBe(true)
    expect(isFullT7(g0)).toBe(false)
    expect(evaluateTrackedT7(g0, formatT7Report(g0)).ok).toBe(true)
    expect(formatT7Report(g0)).toContain('不是完整 T7')
    expect(formatT7Report(g0)).not.toContain('Web-only T7')
  })

  it('accepts the honest contract unavailable pollution shape only with send-window proof', () => {
    const full = buildT7Document(fullJourneyObservation())
    expect(full.pollutionProbes).toEqual(honestPollutionProbes())
    expect(full.postCallSnapshot).toEqual(observedPostCallSnapshot())
    expect(full.postSendSnapshot).toEqual(observedPostSendSnapshot())
    expect(full.sendComparisons.sessionCount).toBe('unchanged')
    expect(full.sendComparisons.blankTurns).toBe('changed')
    expect(full.postSendSnapshot.blankTurns).toEqual({
      available: true,
      status: 'observed',
      blank: false,
      hasTurns: true,
    })
    expect(full.comparisons).toEqual({
      sessionCount: 'unchanged',
      blankTurns: 'unchanged',
      officialUsage: 'unchanged',
    })
    expect(validateT7Structure(full).ok).toBe(true)
    expect(isFullT7(full)).toBe(true)
    expect(isG0Pass(full)).toBe(false)
  })

  it('rejects missing post-send fields, clarify-window changes, and post-send without turns', () => {
    const full = buildT7Document(fullJourneyObservation())
    const missingSend = { ...full }
    delete missingSend.postSendSnapshot
    delete missingSend.sendComparisons
    expect(validateT7Structure(missingSend).ok).toBe(true)
    expect(isFullT7(missingSend)).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      postSendSnapshot: undefined,
    })))).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      postCallSnapshot: observedPostCallSnapshot({
        blankTurns: observedBlankTurns(false, true),
      }),
    })))).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      postCallSnapshot: observedPostCallSnapshot({
        sessionCount: observedCount('one'),
      }),
    })))).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      postSendSnapshot: observedPostSendSnapshot({
        blankTurns: observedBlankTurns(true, false),
      }),
    })))).toBe(false)
    expect(isFullT7(buildT7Document(fullJourneyObservation({
      postSendSnapshot: observedPostSendSnapshot({
        blankTurns: observedBlankTurns(),
      }),
    })))).toBe(false)
    const missingFlag = buildT7Document(fullJourneyObservation({
      postSendSnapshot: {
        sessionCount: observedCount('many'),
        blankTurns: observedBlankTurns(false, true),
        officialUsage: observedUsage('zero'),
      },
    }))
    expect(validateT7Structure(missingFlag).ok).toBe(false)
    expect(isFullT7(missingFlag)).toBe(false)
  })

  it('still allows fullT7 when official usage stays zero after send', () => {
    const full = buildT7Document(fullJourneyObservation({
      postSendSnapshot: observedPostSendSnapshot({
        officialUsage: observedUsage('zero'),
      }),
    }))
    expect(full.preCallSnapshot.officialUsage.band).toBe('zero')
    expect(full.postCallSnapshot.officialUsage.band).toBe('zero')
    expect(full.postSendSnapshot.officialUsage.band).toBe('zero')
    expect(full.sendComparisons.officialUsage).toBe('unchanged')
    expect(full.sendComparisons.sessionCount).toBe('unchanged')
    expect(full.sendComparisons.blankTurns).toBe('changed')
    expect(isFullT7(full)).toBe(true)
  })

  it('rejects missing or wrong beforeOfficialSend and a changed send-window sessionCount', () => {
    const missingBoundary = buildT7Document(fullJourneyObservation({
      postCallSnapshot: {
        sessionCount: observedCount('many'),
        blankTurns: observedBlankTurns(),
        officialUsage: observedUsage(),
      },
    }))
    expect(missingBoundary.postCallSnapshot).not.toHaveProperty('beforeOfficialSend')
    expect(validateT7Structure(missingBoundary).ok).toBe(true)
    expect(isFullT7(missingBoundary)).toBe(false)
    const wrongBoundary = buildT7Document(fullJourneyObservation({
      postCallSnapshot: observedPostCallSnapshot({ beforeOfficialSend: false }),
    }))
    expect(validateT7Structure(wrongBoundary).ok).toBe(false)
    expect(validateT7Structure(wrongBoundary).errors.join(' ')).toMatch(/beforeOfficialSend/)
    expect(isFullT7(wrongBoundary)).toBe(false)
    const switchedSession = buildT7Document(fullJourneyObservation({
      postSendSnapshot: observedPostSendSnapshot({
        sessionCount: observedCount('one'),
      }),
    }))
    expect(switchedSession.sendComparisons.sessionCount).toBe('changed')
    expect(switchedSession.sendComparisons.blankTurns).toBe('changed')
    expect(validateT7Structure(switchedSession).ok).toBe(true)
    expect(isFullT7(switchedSession)).toBe(false)
    expect(isG0Pass(buildT7Document(g0Observation({
      postCallSnapshot: observedPostCallSnapshot(),
    })))).toBe(true)
    expect(validateT7Structure(buildT7Document(g0Observation({
      postCallSnapshot: {
        sessionCount: observedCount('many'),
        blankTurns: observedBlankTurns(),
        officialUsage: observedUsage(),
        beforeOfficialSend: false,
      },
    }))).ok).toBe(false)
  })
})

describe('checked-in 0.1.1-rc.2 T7 evidence', () => {
  it('records the checksum-verified no-key G0 pass without claiming full T7 or a new joint baseline', () => {
    expect(existsSync(join(root, 'docs/t7-evidence/0.1.1-rc.2/t7.json'))).toBe(true)
    expect(existsSync(join(root, 'docs/t7-evidence/0.1.1-rc.2/t7-report.md'))).toBe(true)
    const doc = trackedEvidence()
    const checked = validateT7Document(doc)
    expect(checked.ok).toBe(true)
    expect(doc.protocol).toBe('t7/1')
    expect(doc.hostVersion).toBe('0.1.1-rc.2')
    expect(doc.clarifyVersion).toBe('0.2.2')
    expect(doc.gate).toBe('G0')
    expect(doc.g0Verdict).toBe('通过')
    expect(isG0Pass(doc)).toBe(true)
    expect(doc.fullT7).toBe(false)
    expect(isFullT7(doc)).toBe(false)
    expect(doc.noKey).toBe(true)
    expect(doc.mock).toBe(false)
    expect(doc.seekTtyProven).toBe(true)
    expect(doc.seekTtyInstalled).toBe(false)
    expect(doc.recommendedJointBaseline).toBe(false)
    expect(doc.asset).toMatchObject({
      mode: 'from-release',
      checksumVerified: true,
      userValue: true,
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    })
    expect(doc.session).toEqual({
      source: 'official-public-remote',
      productionPluginCreated: false,
      createdByThisScript: true,
    })
    expect(doc.preCallSnapshot.immediate).toBe(true)
    expect(doc.preCallSnapshot.beforeFirstClarifyRpc).toBe(true)
    expect(doc.preCallSnapshot.sessionCount).toEqual({ available: true, status: 'observed', band: 'one' })
    expect(doc.preCallSnapshot.blankTurns).toEqual({ available: true, status: 'observed', blank: true, hasTurns: false })
    expect(doc.preCallSnapshot.officialUsage).toEqual({ available: true, status: 'observed', band: 'zero' })
    expect(doc.postCallSnapshot.sessionCount).toEqual({ available: true, status: 'observed', band: 'one' })
    expect(doc).not.toHaveProperty('pollutionProbes')
    expect(doc).not.toHaveProperty('postSendSnapshot')
    expect(doc).not.toHaveProperty('sendComparisons')
    expect(doc.postCallSnapshot).not.toHaveProperty('beforeOfficialSend')
    expect(doc.comparisons).toEqual({
      sessionCount: 'unchanged',
      blankTurns: 'unchanged',
      officialUsage: 'unchanged',
    })
    expect(doc.start).toEqual({
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
      missingCredential: false,
    })
    expect(doc.diy).toEqual({
      present: true,
      createsSession: false,
      methods: {
        start: true,
        answer: true,
        accept: true,
        refine: true,
        cancel: true,
        fetchDraft: true,
      },
    })
    const raw = JSON.stringify(doc)
    expect(raw).not.toMatch(/sessionId|seedText|draftPreview|openai|sk-|\/Users\/|\/Volumes\/|totalTokens|uncachedInputTokens/)
    expect(raw).not.toMatch(/"provider"|"model"/)
    expect(raw).not.toMatch(/MISSING_CREDENTIAL|auxiliary model|<!doctype|<html|dump-config/)
  })

  it('keeps the markdown report honest that G0 passed and T7 is still incomplete', () => {
    const report = readFileSync(join(root, 'docs/t7-evidence/0.1.1-rc.2/t7-report.md'), 'utf8')
    const doc = trackedEvidence()
    const generated = formatT7Report(doc)
    const evaluated = evaluateTrackedT7(doc, report)
    expect(evaluated.ok).toBe(true)
    expect(evaluated.g0).toBe(true)
    expect(evaluated.fullT7).toBe(false)
    expect(report).toContain(T7_PROTOCOL)
    expect(report).toMatch(/\| G0 \| 通过/)
    expect(report).toMatch(/\| 完整 T7 \| 否/)
    expect(report).toContain('不是完整 T7')
    expect(report).toContain('无 key / mock 不等于完整 T7')
    expect(report).toContain('INFERENCE_UNAVAILABLE')
    expect(report).toContain('providerFailureCode=ENOTSUP')
    expect(report).toMatch(/session 计数：`unchanged`/)
    expect(report).toMatch(/\| SeekTTY \| 未安装/)
    expect(report).not.toMatch(/MISSING_CREDENTIAL/)
    expect(report).not.toMatch(/sessionId|sk-|\/Users\/|totalTokens|<!doctype|auxiliary model/)
    expect(generated).toMatch(/\| G0 \| 通过/)
    expect(generated).toContain('不是完整 T7')
    expect(generated).toContain('providerFailureCode=ENOTSUP')
    expect(generated).not.toMatch(/MISSING_CREDENTIAL/)
  })
})

describe('checked-in 0.1.1-rc.2 Web-only full T7 evidence', () => {
  it('keeps frozen G0 bytes and t7:validate on the G0 pair only', () => {
    expect(sha256File(G0_JSON)).toBe(FROZEN_G0_JSON_SHA256)
    expect(readFileSync(G0_JSON).byteLength).toBe(1964)
    expect(sha256File(G0_REPORT)).toBe(FROZEN_G0_REPORT_SHA256)
    expect(readFileSync(G0_REPORT).byteLength).toBe(1296)
    expect(FROZEN_G0_EVIDENCE).toEqual([
      'docs/t7-evidence/0.1.1-rc.2/t7.json',
      'docs/t7-evidence/0.1.1-rc.2/t7-report.md',
    ])
    const lab = readFileSync(join(root, 'scripts/t7-lab.mjs'), 'utf8')
    expect(lab).toContain("join(evidenceDir, 't7.json')")
    expect(lab).toContain("join(evidenceDir, 't7-report.md')")
    expect(lab).not.toMatch(/t7-full/)
  })

  it('records a schema-valid Web-only full T7 pair with no leaks', () => {
    expect(existsSync(FULL_JSON)).toBe(true)
    expect(existsSync(FULL_REPORT)).toBe(true)
    const doc = JSON.parse(readFileSync(FULL_JSON, 'utf8'))
    const report = readFileSync(FULL_REPORT, 'utf8')
    expect(validateT7Document(doc).ok).toBe(true)
    expect(isFullT7(doc)).toBe(true)
    expect(isG0Pass(doc)).toBe(false)
    expect(doc.fullT7).toBe(true)
    expect(doc.g0Verdict).toBe('阻塞')
    expect(doc.gate).toBe('T7')
    expect(doc.noKey).toBe(false)
    expect(doc.mock).toBe(false)
    expect(sanitizeT7Document(doc)).toEqual(doc)
    expect(formatT7Report(doc)).toBe(report)
    const evaluated = evaluateTrackedT7(doc, report)
    expect(evaluated).toMatchObject({ ok: true, fullT7: true, g0: false })
    expect(doc).toMatchObject({
      protocol: 't7/1',
      hostVersion: '0.1.1-rc.2',
      clarifyVersion: '0.2.2',
      seekTtyProven: true,
      seekTtyInstalled: false,
      recommendedJointBaseline: false,
      webOnlyComplete: true,
      draftManuallyPasted: true,
      userSent: true,
      pluginAutoSent: false,
      asset: {
        mode: 'from-release',
        checksumVerified: true,
        userValue: true,
        clarifyRelease: '0.2.2',
        auxiliaryRelease: '0.1.1',
      },
      session: {
        source: 'official-public-remote',
        productionPluginCreated: false,
        createdByThisScript: true,
      },
      preCallSnapshot: {
        immediate: true,
        beforeFirstClarifyRpc: true,
        sessionCount: { available: true, status: 'observed', band: 'one' },
        blankTurns: { available: true, status: 'observed', blank: true, hasTurns: false },
        officialUsage: { available: true, status: 'observed', band: 'zero' },
      },
      postCallSnapshot: {
        beforeOfficialSend: true,
        sessionCount: { available: true, status: 'observed', band: 'one' },
        blankTurns: { available: true, status: 'observed', blank: true, hasTurns: false },
        officialUsage: { available: true, status: 'observed', band: 'zero' },
      },
      comparisons: {
        sessionCount: 'unchanged',
        blankTurns: 'unchanged',
        officialUsage: 'unchanged',
      },
      diyJourney: {
        surface: 'host-diy',
        ok: true,
        methods: {
          start: 'succeeded',
          answer: 'succeeded',
          accept: 'succeeded',
          refine: 'succeeded',
          cancel: 'succeeded',
          fetchDraft: 'succeeded',
        },
      },
      manualDraftTransfer: { observed: true, method: 'manual-paste', autoFilled: false },
      officialComposerSend: { observed: true, channel: 'official-web-composer' },
      cancelRecovery: { observed: true, cancelled: true, recovered: true },
      pollutionProbes: {
        source: 'contract',
        window: 'clarify-only',
        transcript: 'unavailable',
        queue: 'unavailable',
        pending: 'unavailable',
        plan: 'unavailable',
        goal: 'unavailable',
      },
      postSendSnapshot: {
        afterOfficialSend: true,
        sessionCount: { available: true, status: 'observed', band: 'one' },
        blankTurns: { available: true, status: 'observed', blank: false, hasTurns: true },
        officialUsage: { available: true, status: 'observed', band: 'nonzero' },
      },
      sendComparisons: {
        sessionCount: 'unchanged',
        blankTurns: 'changed',
        officialUsage: 'changed',
      },
    })
    expect(report).toContain('Web-only T7')
    expect(report).toContain('| 完整 T7 | 是')
    expect(report).toContain('| G0 | 阻塞')
    expect(report).toContain('不是 T4 transcript dump')
    expect(report).toContain('不是 T5 stale')
    expect(report).toContain('不是 T6 usage/limits')
    expect(report).toContain('也不是新推荐联合基线')
    expect(report).toContain('有 turn')
    expect(report).not.toContain('剩余 Codex live T7')
    expect(report).not.toContain('本文件记录一次完整 T7')
    const leaked = `${JSON.stringify(doc)}\n${report}`
    expect(leaked).not.toMatch(/sessionId|seedText|draftPreview|openai|sk-|\/Users\/|\/Volumes\/|totalTokens|uncachedInputTokens/)
    expect(leaked).not.toMatch(/MISSING_CREDENTIAL|auxiliary model|<!doctype|<html|dump-config/)
  })

  it('pins the pre-write full evidence bytes', () => {
    expect(readFileSync(FULL_JSON).byteLength).toBe(3182)
    expect(sha256File(FULL_JSON)).toBe(PREWRITE_FULL_JSON_SHA256)
    expect(readFileSync(FULL_REPORT).byteLength).toBe(1233)
    expect(sha256File(FULL_REPORT)).toBe(PREWRITE_FULL_REPORT_SHA256)
  })
})

describe('docs and instructions stay aligned with published 0.2.2 T7', () => {
  it('corrects task-book 6.7, T6, and 11.5 to official tokenUsage plus private auxiliary_runtime', () => {
    const book = readFileSync(join(root, 'docs/任务书A-clarify-host-plugin.md'), 'utf8')
    expect(book).toMatch(/### 6\.7 用量归属[\s\S]*官方 Agent[\s\S]*tokenUsage[\s\S]*权威/)
    expect(book).toMatch(/### 6\.7 用量归属[\s\S]*auxiliary_runtime/)
    expect(book).not.toMatch(/### 6\.7 用量归属[\s\S]*记入绑定 Session 的用量/)
    expect(book).not.toMatch(/6\.7 用量 \/ accounting：本条原文保持不变/)
    expect(book).toMatch(/\| T6 \|[\s\S]*官方 Agent `tokenUsage`[\s\S]*auxiliary_runtime/)
    expect(book).not.toMatch(/\| T6 \|[\s\S]*补全消耗出现在 Session 用量中/)
    expect(book).toMatch(/5\. \*\*usage \/ limits\*\*：[\s\S]*官方 Agent `tokenUsage`[\s\S]*auxiliary_runtime/)
    expect(book).not.toMatch(/5\. \*\*usage \/ limits\*\*：消耗记入 Session 用量/)
  })

  it('does not recommend a new joint baseline for published 0.2.2', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const compatibility = readFileSync(join(root, 'docs/compatibility.md'), 'utf8')
    const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    for (const text of [readme, compatibility, instructions]) {
      expect(text).not.toMatch(/当前未发布目标是 `0\.2\.2`/)
      expect(text).not.toMatch(/未发布新目标 `0\.2\.2`/)
      expect(text).not.toMatch(/## 0\.2\.2 目标（未发布）/)
      expect(text).toContain('0.2.2')
      expect(text).toContain('0.1.0-rc.8')
      expect(text).toContain('0.2.1')
      expect(text).toContain('1.2.0')
    }
    expect(readme).toContain('已发布旧栈（回滚）')
    expect(readme).not.toMatch(/推荐(?:联合)?(?:基线|组合|栈)[^\n]*0\.1\.1-rc\.2[^\n]*0\.2\.2[^\n]*SeekTTY/)
    expect(readme).not.toMatch(/推荐(?:联合)?(?:基线|组合|栈)[^\n]*0\.2\.2[^\n]*0\.1\.1[^\n]*SeekTTY/)
    expect(compatibility).toMatch(/已发布/)
    expect(compatibility).toContain('不是推荐联合基线')
    expect(compatibility).toMatch(/T7 G0[\s\S]*通过/)
    expect(compatibility).toMatch(/不是完整 T7/)
    expect(readme).toMatch(/T7 G0[\s\S]*通过/)
    expect(readme).toMatch(/不是完整 T7/)
    expect(readme).not.toMatch(/今天在精确/)
    expect(readme).toContain('docs/t7-evidence/0.1.1-rc.2')
    expect(readme).toContain('t7-full.json')
    expect(readme).toContain('t7-full-report.md')
    expect(compatibility).toContain('t7-full.json')
    expect(compatibility).toContain('t7-full-report.md')
    expect(readme).not.toMatch(/t7:validate[^\n]*fullT7=true/)
    expect(compatibility).not.toMatch(/t7:validate[^\n]*fullT7=true/)
  })

  it('keeps t7 lab and schema files on the allowed harness surface', () => {
    const lab = readFileSync(join(root, 'scripts/t7-lab.mjs'), 'utf8')
    expect(lab).toContain('--from-pack')
    expect(lab).toContain('--from-release')
    expect(lab).toContain('--validate')
    expect(lab).toContain('--require-local-assets')
    expect(lab).toContain('evaluateTrackedT7')
    expect(lab).not.toMatch(/error\.stack/)
    expect(lab).toContain('official-public-remote')
    expect(lab).toContain('beforeFirstClarifyRpc')
    expect(lab).toContain('stripProviderKeys')
    expect(lab).toContain('assertExactDshVersion')
    expect(lab).toContain('--dump-config')
    expect(lab).toContain('observeSeekTtyInstalled')
    expect(lab).toMatch(/--port',\s*'0'/)
    expect(lab).toContain('--no-open')
    expect(lab).toMatch(/AbortSignal\.timeout\(8000\)/)
    expect(lab).toMatch(/docs',\s*'t7-evidence',\s*args\.dshVersion/)
    expect(lab).not.toMatch(/session\.prompt/)
    expect(lab).not.toMatch(/session\.get|session\.current/)
    expect(lab).not.toMatch(/不适用：--from-release/)
    expect(existsSync(join(root, 'scripts/lib/t7-schema.mjs'))).toBe(true)
    expect(existsSync(join(root, 'scripts/lib/t7-surfaces.mjs'))).toBe(true)
  })
})

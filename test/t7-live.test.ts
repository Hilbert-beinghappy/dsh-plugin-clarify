import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { requireFromReleaseAssets } from '../scripts/lib/t7-schema.mjs'
import {
  DIY_LIVE_STEPS,
  FROZEN_G0_EVIDENCE,
  LiveBlock,
  ambiguousLiveSeed,
  applyDiyJourneyEvent,
  applyDiyJourneySequence,
  armOfficialSendGate,
  attachNetwork,
  assertLiveRouteCredential,
  canAdvanceDiyJourney,
  classifyLiveEndpoint,
  classifyOnboardingDeadline,
  classifyPostSendPhase,
  clampOfficialPostSendTimeout,
  classifyRouteCredential,
  classifyStartPreflight,
  clickExactOnboardingButton,
  comparePastedComposer,
  createDiyJourneyMachine,
  createOfficialSendGate,
  deriveManualDraftTransfer,
  deriveOfficialPromptAdmission,
  deriveOfficialSendReceipts,
  dismissOfficialOnboarding,
  expectedDiyMethod,
  extractClarifyReceipt,
  extractOfficialPromptReceipt,
  formatBlockedOutput,
  formatLiveSuccessStdout,
  honestPollutionProbes,
  invokeDiyStep,
  isT7LiveMain,
  liveAssetIo,
  liveBlockFromPointerFailure,
  liveJourneyReceipts,
  noteOfficialPromptResponse,
  noteOfficialSendAttempt,
  OFFICIAL_POST_SEND_POLL_INTERVAL_MS,
  OFFICIAL_POST_SEND_TIMEOUT_MAX_MS,
  OFFICIAL_PROMPT_POLL_INTERVAL_MS,
  OFFICIAL_PROMPT_RESPONSE_TIMEOUT_MS,
  OFFICIAL_STEP_END_TIMEOUT_MS,
  OFFICIAL_TURN_START_TIMEOUT_MS,
  observeCredentialPresence,
  officialPasteShortcut,
  officialSendLocatorSelector,
  parseT7LiveArgs,
  planOfficialOnboardingAction,
  planLiveRun,
  planRouteDispatch,
  requireManualPasteProof,
  requireOfficialSendEnabled,
  requireSeededPublicSnapshot,
  resolveLiveAssets,
  runT7Live,
  sanitizeLiveStdout,
  selectDiyAnswerAction,
  selectOfficialComposerCard,
  waitForOfficialSessionDelta,
  waitForPostSendProjection,
  waitOfficialPromptAdmission,
  withIsolatedT7LiveHome,
} from '../scripts/t7-live.mjs'
import {
  OFFICIAL_ONBOARDING_LATER_LABELS,
  OFFICIAL_ONBOARDING_SAVE_LABELS,
  OFFICIAL_SEND_CONTROL_SELECTOR,
  OFFICIAL_SEND_LABELS,
  OFFICIAL_WELCOME_LABELS,
  isVisibleComposerCard,
  isWritableComposerTextarea,
  listSessionIds,
  sessionListDelta,
} from '../scripts/lib/t7-surfaces.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const liveSource = readFileSync(join(root, 'scripts/t7-live.mjs'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function fromReleaseArgs(extra: string[] = []) {
  return [
    '--from-release',
    '--require-local-assets',
    '--clarify-release', '0.2.2',
    '--auxiliary-release', '0.1.1',
    ...extra,
  ]
}

function startRunning(kind: 'ask' | 'await_accept' = 'ask', hasQuestion = kind === 'ask') {
  return {
    method: 'start',
    ok: true,
    status: 'running',
    kind,
    hasQuestion,
  }
}

function fakeReleaseIo() {
  const files = new Map<string, Buffer | string>([
    ['dsh-plugin-clarify-0.2.2.tgz', Buffer.from('clarify-bytes')],
    ['CLARIFY.SUMS', `${createHash('sha256').update('clarify-bytes').digest('hex')}  dsh-plugin-clarify-0.2.2.tgz\n`],
    ['dsh-plugin-auxiliary-runtime-0.1.1.tgz', Buffer.from('aux-bytes')],
    ['AUX.SUMS', `${createHash('sha256').update('aux-bytes').digest('hex')}  dsh-plugin-auxiliary-runtime-0.1.1.tgz\n`],
  ])
  return {
    readFileSync: (path: string, encoding?: string) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`ENOENT: ${path}`)
      return encoding ? String(value) : value
    },
    basename: (path: string) => path.split('/').pop() ?? path,
  }
}

function fromReleaseAssetArgs() {
  return fromReleaseArgs([
    '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
    '--clarify-sums', 'CLARIFY.SUMS',
    '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
    '--auxiliary-sums', 'AUX.SUMS',
  ])
}

describe('t7-live argv and assets', () => {
  it('requires --from-release and the existing exact local asset flags', () => {
    expect(() => parseT7LiveArgs([])).toThrow(LiveBlock)
    try {
      parseT7LiveArgs([])
    } catch (error) {
      expect(error).toMatchObject({ code: 'FROM_RELEASE_REQUIRED', category: 'argv' })
    }
    expect(() => parseT7LiveArgs(['--validate'])).toThrow(/UNSUPPORTED_MODE/)
    expect(() => parseT7LiveArgs(['--from-pack'])).toThrow(/UNSUPPORTED_MODE/)
    expect(() => parseT7LiveArgs(['--from-release', '--write'])).toThrow(/WRITE_REFUSED/)
    expect(() => parseT7LiveArgs(['--from-release', '--dsh-version', '0.1.0-rc.8'])).toThrow(/DSH_VERSION/)
    const parsed = parseT7LiveArgs(fromReleaseArgs([
      '--clarify-tgz', 'dsh-plugin-clarify-0.2.2.tgz',
      '--clarify-sums', 'CLARIFY.SUMS',
      '--auxiliary-tgz', 'dsh-plugin-auxiliary-runtime-0.1.1.tgz',
      '--auxiliary-sums', 'AUX.SUMS',
    ]))
    expect(parsed).toMatchObject({
      mode: 'from-release',
      dshVersion: '0.1.1-rc.2',
      write: false,
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    })
    expect(() => requireFromReleaseAssets(parseT7LiveArgs(['--from-release']))).toThrow(/tgz|SHA256SUMS|阻塞/)
  })

  it('resolves checksums through named assetIo and never treats leftover hooks as IO', async () => {
    const parsed = parseT7LiveArgs(fromReleaseAssetArgs())
    const assetIo = fakeReleaseIo()
    expect(liveAssetIo({})).toBeUndefined()
    expect(liveAssetIo({ env: {}, execute() {} })).toBeUndefined()
    expect(liveAssetIo({ assetIo, execute() {} })).toBe(assetIo)
    expect(resolveLiveAssets(parsed, { env: {}, execute() {}, assetIo })).toMatchObject({
      mode: 'from-release',
      checksumVerified: true,
      userValue: true,
      clarifyRelease: '0.2.2',
      auxiliaryRelease: '0.1.1',
    })
    let seen: { checksumVerified?: boolean; mode?: string } | undefined
    await expect(runT7Live(fromReleaseAssetArgs(), {
      env: { OPENAI_API_KEY: 'x' },
      assetIo,
      execute({ asset }: { asset: { checksumVerified?: boolean; mode?: string } }) {
        seen = asset
        return { ok: true, asset }
      },
    })).resolves.toMatchObject({ ok: true })
    expect(seen).toMatchObject({
      mode: 'from-release',
      checksumVerified: true,
    })
    expect(JSON.stringify(seen)).not.toMatch(/OPENAI|sk-|API_KEY/)
  })
})

describe('t7-live credential presence', () => {
  it('returns only a coarse boolean and never names or values', () => {
    const present = observeCredentialPresence({
      OPENAI_API_KEY: 'sk-secret-value',
      KEEP: 'yes',
    })
    const absent = observeCredentialPresence({ KEEP: 'yes', OPENAI_API_KEY: '' })
    const empty = observeCredentialPresence({})
    expect(present).toEqual({ present: true })
    expect(absent).toEqual({ present: false })
    expect(empty).toEqual({ present: false })
    const serialized = JSON.stringify({ present, absent, empty })
    expect(serialized).not.toMatch(/OPENAI|DEEPSEEK|API_KEY|sk-secret|KEEP/)
    expect(present).not.toHaveProperty('name')
    expect(present).not.toHaveProperty('value')
    expect(present).not.toHaveProperty('env')
  })

  it('does not launch a browser, boot a host, or call a provider when credentials are absent', async () => {
    const plan = planLiveRun({ presence: { present: false } })
    expect(plan).toEqual({
      launchBrowser: false,
      bootHost: false,
      callProvider: false,
      block: { code: 'MISSING_CREDENTIAL', category: 'preflight' },
    })
    const hooks = {
      env: {},
      bootHost() {
        throw new Error('bootHost must not run')
      },
      launchBrowser() {
        throw new Error('launchBrowser must not run')
      },
      readFileSync() {
        throw new Error('readFileSync must not run')
      },
    }
    await expect(runT7Live(['--from-release'], hooks)).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
      category: 'preflight',
    })
    expect(planLiveRun({ presence: { present: true } })).toEqual({
      launchBrowser: true,
      bootHost: true,
      callProvider: true,
      block: null,
    })
  })
})

describe('t7-live route-aware credential preflight', () => {
  it('matches a known route when the corresponding env is present and returns only coarse fields', () => {
    const dump = agentDefaultModelDump('deepseek-official')
    const classified = classifyRouteCredential(dump, { DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'y' })
    expect(classified).toEqual({ ok: true })
    expect(Object.keys(classified)).toEqual(['ok'])
    expectSafeRouteResult(classified, dump)
    expect(assertLiveRouteCredential(dump, { DEEPSEEK_API_KEY: 'x' })).toEqual({ ok: true })
    expect(planRouteDispatch(classified)).toEqual({
      launchBrowser: true,
      bootHost: true,
      callProvider: true,
      block: null,
    })
    expectSafeRouteResult(planRouteDispatch(classified), dump)
    expect(classifyRouteCredential(agentDefaultModelDump('openai'), { OPENAI_API_KEY: 'x' })).toEqual({ ok: true })
  })

  it('blocks an unrelated present key as ROUTE_CREDENTIAL_MISMATCH without dispatch', () => {
    const dump = decoyDump('deepseek-official')
    const classified = classifyRouteCredential(dump, { OPENAI_API_KEY: 'sk-unrelated', DEEPSEEK_API_KEY: '' })
    expect(classified).toEqual({
      ok: false,
      code: 'ROUTE_CREDENTIAL_MISMATCH',
      category: 'preflight',
    })
    expect(Object.keys(classified).sort()).toEqual(['category', 'code', 'ok'])
    expectSafeRouteResult(classified, dump)
    expect(() => assertLiveRouteCredential(dump, { OPENAI_API_KEY: 'sk-unrelated' })).toThrow(LiveBlock)
    try {
      assertLiveRouteCredential(dump, { OPENAI_API_KEY: 'sk-unrelated' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'ROUTE_CREDENTIAL_MISMATCH', category: 'preflight' })
      expect(error.message).toBe('ROUTE_CREDENTIAL_MISMATCH preflight')
      expectSafeRouteResult(error, dump)
    }
    expect(planRouteDispatch(classified)).toEqual({
      launchBrowser: false,
      bootHost: false,
      callProvider: false,
      block: { code: 'ROUTE_CREDENTIAL_MISMATCH', category: 'preflight' },
    })
  })

  it('returns UNKNOWN for unknown, missing, duplicate, and non-config provider lines', () => {
    const unknown = classifyRouteCredential(agentDefaultModelDump('deepseek'), { DEEPSEEK_API_KEY: 'x' })
    const missing = classifyRouteCredential('# == dsh-plugin-clarify\n- id: clarify\n  name: dsh-plugin-clarify\n', {
      OPENAI_API_KEY: 'x',
    })
    const empty = classifyRouteCredential('', { OPENAI_API_KEY: 'x' })
    const noNested = classifyRouteCredential([
      '- id: agent-default-model',
      '  provider: deepseek-official',
      '  searchProvider: deepseek-official',
    ].join('\n'), { DEEPSEEK_API_KEY: 'x' })
    const searchOnly = classifyRouteCredential([
      '- id: agent-default-model',
      '  config:',
      '    searchProvider: deepseek-official',
      '    model: deepseek-v4-flash',
    ].join('\n'), { DEEPSEEK_API_KEY: 'x' })
    const nestedOther = classifyRouteCredential([
      '- id: agent-default-model',
      '  config:',
      '    extra:',
      '      provider: openai',
    ].join('\n'), { OPENAI_API_KEY: 'x' })
    const duplicate = classifyRouteCredential(
      `${agentDefaultModelDump('deepseek-official')}\n${agentDefaultModelDump('openai')}`,
      { DEEPSEEK_API_KEY: 'x', OPENAI_API_KEY: 'x' },
    )
    const elsewhere = classifyRouteCredential([
      '- id: llm',
      '  config:',
      '    provider: openai',
      '- id: other',
      '  provider: deepseek-official',
    ].join('\n'), { OPENAI_API_KEY: 'x' })
    for (const classified of [unknown, missing, empty, noNested, searchOnly, nestedOther, duplicate, elsewhere]) {
      expect(classified).toEqual({
        ok: false,
        code: 'ROUTE_CREDENTIAL_UNKNOWN',
        category: 'preflight',
      })
      expectSafeRouteResult(classified)
      expect(planRouteDispatch(classified)).toEqual({
        launchBrowser: false,
        bootHost: false,
        callProvider: false,
        block: { code: 'ROUTE_CREDENTIAL_UNKNOWN', category: 'preflight' },
      })
    }
  })

  it('accepts whitespace, quotes, and CRLF around the nested config.provider', () => {
    const crlf = [
      '# == @deepseek-ai/dsh-agent-default-model',
      '- id:   "agent-default-model"  ',
      '  config:',
      '    searchProvider: openai',
      '    provider:   \'deepseek-official\'  ',
      '',
    ].join('\r\n')
    expect(classifyRouteCredential(crlf, { DEEPSEEK_API_KEY: 'x' })).toEqual({ ok: true })
    expect(classifyRouteCredential(crlf, { OPENAI_API_KEY: 'x' })).toEqual({
      ok: false,
      code: 'ROUTE_CREDENTIAL_MISMATCH',
      category: 'preflight',
    })
    const spaced = [
      '- name: demo',
      '  id: agent-default-model',
      '  config:',
      '    provider: openai',
    ].join('\n')
    expect(classifyRouteCredential(spaced, { OPENAI_API_KEY: 'x' })).toEqual({ ok: true })
    expectSafeRouteResult(classifyRouteCredential(crlf, { DEEPSEEK_API_KEY: 'x' }), crlf)
  })
})

describe('t7-live sanitizer and blocked output', () => {
  it('strips session, draft, prompt, origin, path, profile, key, provider, and raw counts', () => {
    const sanitized = sanitizeLiveStdout({
      sessionId: 'sess-live-1',
      seedText: 'write a login form',
      draft: 'secret draft text',
      question: 'what should we build?',
      prompt: 'system prompt',
      origin: 'http://127.0.0.1:3847',
      path: '/Users/secret/profile',
      profile: 'web-secret',
      provider: 'openai',
      model: 'gpt-x',
      totalTokens: 41,
      OPENAI_API_KEY: 'sk-secret-value',
    })
    const leaked = JSON.stringify(sanitized)
    expect(sanitized).not.toHaveProperty('sessionId')
    expect(sanitized).not.toHaveProperty('seedText')
    expect(sanitized).not.toHaveProperty('draft')
    expect(sanitized).not.toHaveProperty('question')
    expect(sanitized).not.toHaveProperty('prompt')
    expect(leaked).not.toMatch(/sess-live-1|login form|secret draft|3847|\/Users\/|sk-secret|openai|gpt-x|"41"/i)
    expect(formatBlockedOutput('ENOTSUP', 'preflight')).toBe('ENOTSUP preflight')
    expect(formatBlockedOutput('COMPOSER_UNIDENTIFIED', 'operator')).toBe('COMPOSER_UNIDENTIFIED operator')
    expect(formatBlockedOutput('ENOTSUP', 'preflight')).not.toMatch(/\/|sessionId|sk-/)
  })
})

describe('t7-live DIY state machine', () => {
  it('walks start-cancel then start-answer-refine-accept-fetchDraft-copy', () => {
    expect(DIY_LIVE_STEPS.map((step) => `${step.process}:${step.method}`)).toEqual([
      'A:start',
      'A:cancel',
      'B:start',
      'B:answer',
      'B:refine',
      'B:accept',
      'B:fetchDraft',
      'B:copy',
    ])
    let machine = createDiyJourneyMachine()
    expect(expectedDiyMethod(machine)).toBe('start')
    machine = applyDiyJourneyEvent(machine, startRunning())
    machine = applyDiyJourneyEvent(machine, { method: 'cancel', ok: true, status: 'cancelled' })
    machine = applyDiyJourneyEvent(machine, startRunning())
    machine = applyDiyJourneyEvent(machine, { method: 'answer', ok: true, status: 'running' })
    machine = applyDiyJourneyEvent(machine, { method: 'refine', ok: true, status: 'running' })
    machine = applyDiyJourneyEvent(machine, { method: 'accept', ok: true, status: 'complete' })
    machine = applyDiyJourneyEvent(machine, { method: 'fetchDraft', ok: true, status: 'complete' })
    machine = applyDiyJourneyEvent(machine, { method: 'copy', ok: true })
    expect(machine.status).toBe('complete')
    expect(machine.methods).toEqual({
      start: 'succeeded',
      answer: 'succeeded',
      accept: 'succeeded',
      refine: 'succeeded',
      cancel: 'succeeded',
      fetchDraft: 'succeeded',
    })
    expect(machine.cancelRecovery).toEqual({
      observed: true,
      cancelled: true,
      recovered: true,
    })
    expect(machine.copied).toBe(true)
    expect(DIY_LIVE_STEPS[2]).toMatchObject({ id: 'startB', method: 'start', requireAsk: true })
    expect(DIY_LIVE_STEPS[0].requireAsk).toBeFalsy()
  })

  it('requires the second start to be an ask with a question before answer', () => {
    const noQuestion = applyDiyJourneySequence([
      startRunning(),
      { method: 'cancel', ok: true, status: 'cancelled' },
      startRunning('ask', false),
    ])
    expect(noQuestion).toMatchObject({
      status: 'blocked',
      stopReason: 'START_NO_QUESTION',
      stopCategory: 'configuration',
    })
    expect(noQuestion.methods.answer).toBe('unavailable')
    const notAsk = applyDiyJourneySequence([
      startRunning(),
      { method: 'cancel', ok: true, status: 'cancelled' },
      startRunning('await_accept', false),
    ])
    expect(notAsk).toMatchObject({
      status: 'blocked',
      stopReason: 'START_NOT_ASK',
      stopCategory: 'configuration',
    })
    const ready = applyDiyJourneySequence([
      startRunning(),
      { method: 'cancel', ok: true, status: 'cancelled' },
      startRunning('ask', true),
    ])
    expect(ready.status).toBe('ready')
    expect(expectedDiyMethod(ready)).toBe('answer')
  })

  it('selects the first option or a minimal custom answer and fails closed otherwise', () => {
    expect(selectDiyAnswerAction({ optionCount: 2, allowCustom: false })).toEqual({
      ok: true,
      action: 'first-option',
    })
    expect(selectDiyAnswerAction({ optionCount: 0, allowCustom: true })).toEqual({
      ok: true,
      action: 'custom',
    })
    expect(selectDiyAnswerAction({ optionCount: 0, allowCustom: false })).toMatchObject({
      ok: false,
      code: 'ANSWER_UNAVAILABLE',
      category: 'configuration',
    })
    expect(JSON.stringify(selectDiyAnswerAction({ optionCount: 1, allowCustom: true }))).not.toMatch(/option text|customText|seed/)
  })

  it('stops after the first start preflight failure and ignores later inference', () => {
    const failed = applyDiyJourneyEvent(createDiyJourneyMachine(), {
      method: 'start',
      ok: false,
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
    })
    expect(failed.status).toBe('blocked')
    expect(failed.stopReason).toBe('ENOTSUP')
    expect(failed.stopCategory).toBe('preflight')
    expect(failed.methods).toEqual({
      start: 'failed',
      answer: 'unavailable',
      accept: 'unavailable',
      refine: 'unavailable',
      cancel: 'unavailable',
      fetchDraft: 'unavailable',
    })
    expect(failed.stepIndex).toBe(0)
    const ignored = applyDiyJourneyEvent(failed, { method: 'answer', ok: true, status: 'running' })
    expect(ignored.methods.answer).toBe('unavailable')
    expect(ignored.stepIndex).toBe(0)
    expect(classifyStartPreflight({
      ok: false,
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'MISSING_CREDENTIAL',
    })).toEqual({ ok: false, code: 'MISSING_CREDENTIAL', category: 'preflight' })
    expect(classifyStartPreflight({
      ok: true,
      status: 'running',
      kind: 'ask',
      hasQuestion: false,
    })).toMatchObject({ ok: false, category: 'configuration' })
    const calls: string[] = []
    let current = createDiyJourneyMachine()
    for (const step of [
      { name: 'start', event: { method: 'start', ok: false, providerFailureCode: 'ENOTSUP' } },
      { name: 'cancel', event: { method: 'cancel', ok: true } },
      { name: 'startB', event: startRunning() },
      { name: 'answer', event: { method: 'answer', ok: true } },
    ]) {
      const next = invokeDiyStep(current, (machine) => {
        calls.push(step.name)
        return applyDiyJourneyEvent(machine, step.event)
      })
      current = next.machine
      expect(next.invoked).toBe(step.name === 'start')
    }
    expect(calls).toEqual(['start'])
    expect(canAdvanceDiyJourney(current)).toBe(false)
    expect(current.methods).toEqual({
      start: 'failed',
      answer: 'unavailable',
      accept: 'unavailable',
      refine: 'unavailable',
      cancel: 'unavailable',
      fetchDraft: 'unavailable',
    })
    const ignoredSequence = applyDiyJourneySequence([
      { method: 'start', ok: false, providerFailureCode: 'ENOTSUP' },
      startRunning(),
      { method: 'cancel', ok: true },
      { method: 'answer', ok: true },
    ])
    expect(ignoredSequence.stepIndex).toBe(0)
    expect(ignoredSequence.methods.answer).toBe('unavailable')
    expect(ignoredSequence.methods.cancel).toBe('unavailable')
  })

  it('blocks session.prompt and unexpected method order', () => {
    const prompt = applyDiyJourneyEvent(createDiyJourneyMachine(), { kind: 'session.prompt' })
    expect(prompt).toMatchObject({
      status: 'blocked',
      stopReason: 'SESSION_PROMPT',
      sessionPromptSeen: true,
    })
    const outOfOrder = applyDiyJourneyEvent(createDiyJourneyMachine(), {
      method: 'answer',
      ok: true,
    })
    expect(outOfOrder.stopReason).toBe('UNEXPECTED_METHOD')
  })
})

describe('t7-live network receipts and official composer', () => {
  it('classifies clarify and public reads without treating session.get as an oracle', () => {
    expect(classifyLiveEndpoint('/api/clarify/start')).toEqual({ kind: 'clarify', method: 'start' })
    expect(classifyLiveEndpoint('/api/clarify/fetchDraft')).toEqual({ kind: 'clarify', method: 'fetchDraft' })
    expect(classifyLiveEndpoint('/api/session.list')).toEqual({ kind: 'public', method: 'session.list' })
    expect(classifyLiveEndpoint('/api/session.prompt')).toEqual({ kind: 'forbidden', method: 'session.prompt' })
    expect(classifyLiveEndpoint('/api/session/sess-live/prompt')).toEqual({ kind: 'forbidden', method: 'session.prompt' })
    expect(classifyLiveEndpoint('/api/session.get')).toEqual({ kind: 'other' })
    expect(classifyLiveEndpoint('/api/session.current')).toEqual({ kind: 'other' })
    const receipt = extractClarifyReceipt('/api/clarify/start', {
      type: 'server-response',
      result: {
        ok: true,
        value: {
          protocol: 'clarify.wire/1',
          ok: true,
          value: {
            status: 'running',
            kind: 'ask',
            question: { text: 'leaked question' },
            draftPreview: 'leaked draft',
          },
        },
      },
    })
    expect(receipt).toEqual({
      method: 'start',
      ok: true,
      status: 'running',
      kind: 'ask',
      hasQuestion: true,
    })
    expect(JSON.stringify(receipt)).not.toMatch(/leaked|draft|question text/i)
    const failed = extractClarifyReceipt('/api/clarify/start', {
      type: 'server-response',
      result: {
        ok: false,
        error: {
          code: 'INFERENCE_UNAVAILABLE',
          message: 'auxiliary model call did not succeed (ENOTSUP)',
        },
      },
    })
    expect(failed).toMatchObject({
      method: 'start',
      ok: false,
      errorCode: 'INFERENCE_UNAVAILABLE',
      providerFailureCode: 'ENOTSUP',
    })
    expect(JSON.stringify(failed)).not.toMatch(/auxiliary model|message/)
  })

  it('identifies composer only from a unique visible card, writable textarea, and exact zh/en send label', () => {
    expect(OFFICIAL_SEND_LABELS).toEqual(['Send message', '发送消息'])
    expect(selectOfficialComposerCard([]).ok).toBe(false)
    expect(selectOfficialComposerCard([])).toMatchObject({
      code: 'COMPOSER_UNIDENTIFIED',
      category: 'operator',
    })
    expect(selectOfficialComposerCard([
      { tag: 'textarea', role: 'textbox', ariaLabel: 'Message composer' },
      { tag: 'button', role: 'button', ariaLabel: 'Send message' },
    ])).toMatchObject({
      ok: false,
      code: 'COMPOSER_UNIDENTIFIED',
    })
    const english = selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ placeholder: 'Describe what you want to build' })],
        sends: [officialSend('Send message')],
      }),
    ])
    expect(english.ok).toBe(true)
    expect(english.cardIndex).toBe(0)
    const chinese = selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ placeholder: '描述你想要构建的内容' })],
        sends: [officialSend('发送消息')],
      }),
    ])
    expect(chinese.ok).toBe(true)
    expect(chinese.send.ariaLabel).toBe('发送消息')
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea()],
        sends: [officialSend('Send')],
      }),
    ]).ok).toBe(false)
    expect(officialPasteShortcut('darwin')).toBe('Meta+V')
    expect(officialPasteShortcut('linux')).toBe('Control+V')
  })

  it('rejects non-unique, inert, workspace-trigger, and out-of-card send controls', () => {
    expect(isVisibleComposerCard({ card: true, visible: false })).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ dataPhase: 'inert' }))).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ visible: false }))).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ disabled: true }))).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ readOnly: true }))).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ ariaLabel: 'Choose workspace' }))).toBe(false)
    expect(isWritableComposerTextarea(writableTextarea({ ariaLabel: '选择工作区' }))).toBe(false)
    expect(selectOfficialComposerCard([
      composerCard({ visible: false }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard(),
      composerCard({ cardIndex: 1 }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard(),
      composerCard({ cardIndex: 1, visible: false }),
    ]).ok).toBe(true)
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ dataPhase: 'inert', placeholder: 'Describe what you want to build' })],
        sends: [officialSend('Send message')],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ ariaLabel: 'Choose workspace', readOnly: true })],
        sends: [officialSend('Send message')],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ ariaLabel: '选择工作区' })],
        sends: [officialSend('发送消息')],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea()],
        sends: [officialSend('Stop generating')],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea()],
        sends: [officialSend('停止生成')],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({ sends: [] }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(selectOfficialComposerCard([
      composerCard({
        textareas: [writableTextarea({ visible: false })],
      }),
    ])).toMatchObject({ ok: false, code: 'COMPOSER_UNIDENTIFIED' })
    expect(OFFICIAL_SEND_CONTROL_SELECTOR).toBe('button, [type="submit"], [role="button"]')
    expect(officialSendLocatorSelector('Send message')).toBe(
      'button[aria-label="Send message"], [type="submit"][aria-label="Send message"], [role="button"][aria-label="Send message"]',
    )
    expect(officialSendLocatorSelector('发送消息')).toContain('[role="button"][aria-label="发送消息"]')
  })
})

describe('t7-live official onboarding', () => {
  it('freezes exact bilingual welcome/later labels and refuses Save and continue', () => {
    expect(OFFICIAL_WELCOME_LABELS).toEqual(['Continue', '继续'])
    expect(OFFICIAL_ONBOARDING_LATER_LABELS).toEqual(['Configure later', '稍后配置'])
    expect(OFFICIAL_ONBOARDING_SAVE_LABELS).toEqual(['Save and continue', '保存并继续'])
    expect(planOfficialOnboardingAction({
      rootInert: true,
      buttons: [{ name: 'Continue', visible: true }],
    })).toEqual({ ok: true, action: 'click-welcome', label: 'Continue' })
    expect(planOfficialOnboardingAction({
      rootInert: true,
      buttons: [{ name: '继续', visible: true }],
    })).toEqual({ ok: true, action: 'click-welcome', label: '继续' })
    expect(planOfficialOnboardingAction({
      rootInert: false,
      buttons: [
        { name: 'Configure later', visible: true },
        { name: 'Save and continue', visible: true },
      ],
    })).toEqual({ ok: true, action: 'click-later', label: 'Configure later' })
    expect(planOfficialOnboardingAction({
      rootInert: false,
      buttons: [{ name: 'Configure later', visible: true }],
    })).toEqual({ ok: true, action: 'click-later', label: 'Configure later' })
    expect(planOfficialOnboardingAction({
      rootInert: false,
      buttons: [{ name: '稍后配置', visible: true }],
    })).toEqual({ ok: true, action: 'click-later', label: '稍后配置' })
    expect(planOfficialOnboardingAction({
      rootInert: true,
      buttons: [{ name: 'Save and continue', visible: true }],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' })
    expect(planOfficialOnboardingAction({
      rootInert: true,
      buttons: [{ name: '保存并继续', visible: true }],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' })
    expect(planOfficialOnboardingAction({
      buttons: [
        { name: 'Continue', visible: true },
        { name: 'Save and continue', visible: true },
      ],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED' })
    expect(planOfficialOnboardingAction({
      buttons: [
        { name: 'Continue', visible: true },
        { name: 'Configure later', visible: true },
      ],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED' })
    expect(planOfficialOnboardingAction({
      buttons: [
        { name: 'Continue', visible: true },
        { name: 'Continue', visible: true },
      ],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED' })
    expect(planOfficialOnboardingAction({
      buttons: [
        { name: 'Configure later', visible: true },
        { name: '稍后配置', visible: true },
      ],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_UNIDENTIFIED' })
    expect(planOfficialOnboardingAction({
      rootInert: false,
      buttons: [],
    })).toEqual({ ok: true, action: 'ready' })
    expect(planOfficialOnboardingAction({
      rootInert: true,
      buttons: [],
    })).toMatchObject({ ok: false, code: 'ONBOARDING_BLOCKED', category: 'operator' })
    expect(classifyOnboardingDeadline({ ok: false, code: 'ONBOARDING_BLOCKED' }, { clicked: false })).toMatchObject({
      code: 'ONBOARDING_MISSING',
      category: 'environment',
    })
    expect(classifyOnboardingDeadline({ ok: false, code: 'ONBOARDING_BLOCKED' }, { clicked: true })).toMatchObject({
      code: 'ONBOARDING_PERSIST',
      category: 'environment',
    })
    expect(classifyOnboardingDeadline({ ok: true, action: 'ready' }, { clicked: true })).toEqual({
      ok: true,
      action: 'ready',
    })
    expect(formatBlockedOutput('ONBOARDING_BLOCKED', 'operator')).toBe('ONBOARDING_BLOCKED operator')
    expect(liveBlockFromPointerFailure(new Error('locator.click intercepted'))).toMatchObject({
      name: 'LiveBlock',
      code: 'ONBOARDING_BLOCKED',
      category: 'operator',
    })
    expect(liveBlockFromPointerFailure(new Error('send click intercepted'), 'OFFICIAL_SEND_MISSING')).toMatchObject({
      name: 'LiveBlock',
      code: 'OFFICIAL_SEND_MISSING',
      category: 'operator',
    })
  })

  it('waits for the exact onboarding button to leave after a successful click', async () => {
    const events = []
    const locator = {
      count: async () => 1,
      click: async () => {
        events.push('click')
      },
    }
    await clickExactOnboardingButton({}, 'Continue', {
      getButton: () => locator,
      waitFor: async (target, opts) => {
        expect(target).toBe(locator)
        expect(opts).toMatchObject({ state: 'hidden' })
        events.push('hidden')
      },
    })
    expect(events).toEqual(['click', 'hidden'])

    await expect(clickExactOnboardingButton({}, '继续', {
      getButton: () => ({
        count: async () => 1,
        click: async () => {
          throw new Error('intercepted')
        },
      }),
      waitFor: async () => {
        throw new Error('must not wait after a blocked click')
      },
    })).rejects.toMatchObject({ code: 'ONBOARDING_BLOCKED', category: 'operator' })

    await expect(clickExactOnboardingButton({}, 'Configure later', {
      getButton: () => ({
        count: async () => 1,
        click: async () => {},
      }),
      waitFor: async () => {
        throw new Error('still visible')
      },
    })).rejects.toMatchObject({ code: 'ONBOARDING_PERSIST', category: 'environment' })
  })

  it('clicks unique Continue then optional later, then requires a non-inert ready surface', async () => {
    const clicks = []
    const surfaces = [
      { rootInert: true, buttons: [{ name: 'Continue', visible: true }] },
      { rootInert: true, buttons: [
        { name: 'Configure later', visible: true },
        { name: 'Save and continue', visible: true },
      ] },
      { rootInert: false, buttons: [] },
    ]
    await dismissOfficialOnboarding({}, {
      inspect: async () => surfaces.shift() ?? { rootInert: false, buttons: [] },
      clickLabel: async (_page, label) => {
        clicks.push(label)
      },
      delay: async () => {},
      timeoutMs: 1_000,
    })
    expect(clicks).toEqual(['Continue', 'Configure later'])

    const zhClicks = []
    const zhSurfaces = [
      { rootInert: true, buttons: [{ name: '继续', visible: true }] },
      { rootInert: false, buttons: [] },
    ]
    await dismissOfficialOnboarding({}, {
      inspect: async () => zhSurfaces.shift() ?? { rootInert: false, buttons: [] },
      clickLabel: async (_page, label) => {
        zhClicks.push(label)
      },
      delay: async () => {},
      timeoutMs: 1_000,
    })
    expect(zhClicks).toEqual(['继续'])

    await expect(dismissOfficialOnboarding({}, {
      inspect: async () => ({ rootInert: true, buttons: [] }),
      clickLabel: async () => {
        throw new Error('must not click')
      },
      delay: async () => {},
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: 'ONBOARDING_MISSING', category: 'environment' })

    await expect(dismissOfficialOnboarding({}, {
      inspect: async () => ({
        rootInert: true,
        buttons: [{ name: 'Save and continue', visible: true }],
      }),
      clickLabel: async () => {
        throw new Error('must not click Save')
      },
      delay: async () => {},
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' })

    await expect(dismissOfficialOnboarding({}, {
      inspect: async () => ({
        rootInert: true,
        buttons: [{ name: 'Continue', visible: true }],
      }),
      clickLabel: async () => {},
      delay: async () => {},
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: 'ONBOARDING_PERSIST', category: 'environment' })

    await expect(dismissOfficialOnboarding({}, {
      inspect: async () => ({
        rootInert: false,
        buttons: [
          { name: 'Configure later', visible: true },
          { name: '稍后配置', visible: true },
        ],
      }),
      clickLabel: async () => {
        throw new Error('must not click ambiguous later')
      },
      delay: async () => {},
      timeoutMs: 20,
    })).rejects.toMatchObject({ code: 'ONBOARDING_UNIDENTIFIED', category: 'operator' })
  })
})

describe('t7-live official session list delta', () => {
  it('accepts only an empty-to-one session.list delta and never reads get/current', async () => {
    expect(listSessionIds({ items: [] })).toEqual([])
    expect(listSessionIds({ items: [{ sessionId: 'sess-1' }] })).toEqual(['sess-1'])
    expect(listSessionIds({ items: [{ id: 'sess-1' }] })).toEqual([])
    expect(sessionListDelta([], ['sess-1'])).toEqual({ ok: true, id: 'sess-1' })
    for (const [before, after] of [
      [[], []],
      [[], ['a', 'b']],
      [['a'], ['a', 'b']],
      [['a'], ['a']],
    ] as const) {
      expect(sessionListDelta(before, after)).toMatchObject({
        ok: false,
        code: 'SESSION_DELTA',
        category: 'environment',
      })
    }
    const lists = [
      { items: [] },
      { items: [{ sessionId: 'sess-hydrated' }] },
    ]
    await expect(waitForOfficialSessionDelta(async (_origin, method) => {
      expect(method).toBe('session.list')
      return { ok: true, value: lists.shift() }
    }, 'http://127.0.0.1:1', [], { timeoutMs: 1_000, delay: async () => {} })).resolves.toBe('sess-hydrated')
    await expect(waitForOfficialSessionDelta(async () => ({
      ok: true,
      value: { items: [] },
    }), 'http://127.0.0.1:1', [], { timeoutMs: 20, delay: async () => {} })).rejects.toMatchObject({
      code: 'SESSION_DELTA',
      category: 'environment',
    })
    await expect(waitForOfficialSessionDelta(async () => ({
      ok: true,
      value: { items: [{ sessionId: 'a' }, { sessionId: 'b' }] },
    }), 'http://127.0.0.1:1', [], { timeoutMs: 20, delay: async () => {} })).rejects.toMatchObject({
      code: 'SESSION_DELTA',
      category: 'environment',
    })
    await expect(waitForOfficialSessionDelta(async () => ({
      ok: true,
      value: { items: [{ sessionId: 'b' }] },
    }), 'http://127.0.0.1:1', ['a'], { timeoutMs: 20, delay: async () => {} })).rejects.toMatchObject({
      code: 'SESSION_DELTA',
      category: 'environment',
    })
    expect(() => requireSeededPublicSnapshot({
      sessionCount: { available: true, status: 'observed' },
      blankTurns: { available: false, status: 'unavailable' },
      officialUsage: { available: true, status: 'observed' },
    })).toThrow(/SESSION_SEED/)
    expect(requireSeededPublicSnapshot({
      sessionCount: { available: true, status: 'observed' },
      blankTurns: { available: true, status: 'observed' },
      officialUsage: { available: true, status: 'observed' },
    })).toMatchObject({
      sessionCount: { status: 'observed' },
    })
  })
})

describe('t7-live paste and official send proofs', () => {
  it('compares clipboard to composer inside booleans and derives transfer only from that', () => {
    const matched = comparePastedComposer('draft-one', 'draft-one')
    const mismatched = comparePastedComposer('draft-one', 'draft-two')
    const empty = comparePastedComposer('', '')
    expect(matched).toEqual({ nonEmpty: true, exactMatch: true })
    expect(mismatched).toEqual({ nonEmpty: true, exactMatch: false })
    expect(empty).toEqual({ nonEmpty: false, exactMatch: false })
    expect(Object.keys(matched).sort()).toEqual(['exactMatch', 'nonEmpty'])
    expect(JSON.stringify({ matched, mismatched })).not.toMatch(/draft-one|draft-two/)
    expect(deriveManualDraftTransfer(matched)).toEqual({
      observed: true,
      method: 'manual-paste',
      autoFilled: false,
    })
    expect(deriveManualDraftTransfer(mismatched).observed).toBe(false)
    expect(() => requireManualPasteProof(mismatched)).toThrow(/PASTE_MISMATCH/)
    expect(() => requireManualPasteProof(empty)).toThrow(/PASTE_MISMATCH/)
    const receipts = liveJourneyReceipts({
      pasteProof: mismatched,
      sendGate: armOfficialSendGate(createOfficialSendGate()),
    })
    expect(receipts.manualDraftTransfer.observed).toBe(false)
    expect(receipts.draftManuallyPasted).toBe(false)
    expect(receipts.pasteBlock).toEqual({ code: 'PASTE_MISMATCH', category: 'operator' })
  })

  it('arms official send only after navigation and requires exactly one post-click request', () => {
    const premature = noteOfficialSendAttempt(createOfficialSendGate())
    expect(deriveOfficialSendReceipts(premature)).toMatchObject({
      ok: false,
      code: 'SESSION_PROMPT',
      category: 'forbidden',
      pluginAutoSent: true,
      userSent: false,
      officialComposerSend: { observed: false, channel: 'official-web-composer' },
    })
    const armed = armOfficialSendGate(createOfficialSendGate())
    expect(deriveOfficialSendReceipts(armed)).toMatchObject({
      ok: false,
      code: 'OFFICIAL_SEND_MISSING',
      officialComposerSend: { observed: false },
      pluginAutoSent: false,
    })
    const once = noteOfficialSendAttempt(armed)
    expect(deriveOfficialSendReceipts(once)).toMatchObject({
      ok: true,
      pluginAutoSent: false,
      userSent: true,
      officialComposerSend: { observed: true, channel: 'official-web-composer' },
    })
    expect(() => requireOfficialSendEnabled({ disabled: true })).toThrow(/OFFICIAL_SEND_MISSING/)
    expect(requireOfficialSendEnabled({ disabled: false })).toEqual({ disabled: false })
    const disabledClick = liveJourneyReceipts({
      pasteProof: { nonEmpty: true, exactMatch: true },
      sendGate: createOfficialSendGate(),
    })
    expect(disabledClick.sendOk).toBe(false)
    expect(disabledClick.sendBlock).toEqual({ code: 'OFFICIAL_SEND_MISSING', category: 'operator' })
    const twice = noteOfficialSendAttempt(once)
    expect(deriveOfficialSendReceipts(twice)).toMatchObject({
      ok: false,
      code: 'OFFICIAL_SEND_COUNT',
      officialComposerSend: { observed: false },
    })
    const proven = liveJourneyReceipts({
      pasteProof: { nonEmpty: true, exactMatch: true },
      sendGate: once,
    })
    expect(proven).toMatchObject({
      draftManuallyPasted: true,
      userSent: true,
      pluginAutoSent: false,
      manualDraftTransfer: { observed: true, method: 'manual-paste', autoFilled: false },
      officialComposerSend: { observed: true, channel: 'official-web-composer' },
      sendOk: true,
    })
    const auto = liveJourneyReceipts({
      pasteProof: { nonEmpty: true, exactMatch: true },
      sendGate: premature,
    })
    expect(auto.pluginAutoSent).toBe(true)
    expect(auto.officialComposerSend.observed).toBe(false)
    expect(auto.sendOk).toBe(false)
    expect(deriveOfficialPromptAdmission(once)).toMatchObject({
      ok: false,
      code: 'PROMPT_IN_FLIGHT',
      category: 'environment',
    })
  })

  it('prints a second-pass sanitized document on success', () => {
    const printed = formatLiveSuccessStdout({
      fullT7: true,
      sessionId: 'sess-live-print',
      question: 'leaked question',
      seedText: ambiguousLiveSeed(),
    }, 'report ok')
    expect(printed).toMatch(/fullT7/)
    expect(printed).not.toMatch(/sess-live-print|leaked question/)
    expect(printed).not.toContain(ambiguousLiveSeed())
    expect(ambiguousLiveSeed().length).toBeGreaterThan(0)
    expect(ambiguousLiveSeed().length).toBeLessThan(40)
  })
})

describe('t7-live isolated temp home', () => {
  it('uses a unique system-temp home and cleans only that exact path', async () => {
    const foreign = mkdtempSync(join(tmpdir(), 'unrelated-t7-'))
    writeFileSync(join(foreign, 'keep'), 'ok')
    const seen = []
    try {
      await withIsolatedT7LiveHome((home) => {
        seen.push(home)
        expect(dirname(resolve(home))).toBe(resolve(tmpdir()))
        expect(resolve(home)).not.toBe(resolve(foreign))
        expect(existsSync(home)).toBe(true)
        return 'ok'
      })
      await expect(withIsolatedT7LiveHome(async (home) => {
        seen.push(home)
        throw new LiveBlock('HOST_BOOT', 'environment')
      })).rejects.toMatchObject({ code: 'HOST_BOOT', category: 'environment' })
      expect(seen).toHaveLength(2)
      expect(seen[0]).not.toBe(seen[1])
      expect(existsSync(seen[0])).toBe(false)
      expect(existsSync(seen[1])).toBe(false)
      expect(existsSync(join(foreign, 'keep'))).toBe(true)
    } finally {
      rmSync(foreign, { recursive: true, force: true })
    }

    const removed = []
    await withIsolatedT7LiveHome((home) => {
      expect(home).toBe('/tmp/clarify-t7-live-abc')
    }, {
      tmpdir: () => '/tmp',
      mkdtempSync: (prefix) => `${prefix}abc`,
      rmSync: (path) => {
        removed.push(path)
      },
    })
    expect(removed).toEqual(['/tmp/clarify-t7-live-abc'])
  })
})

describe('t7-live source and package contract', () => {
  it('keeps an independent entry, honest pollution, and a main guard', () => {
    expect(pkg.scripts?.['t7:live']).toBe('node scripts/t7-live.mjs --from-release --require-local-assets --clarify-release 0.2.2 --auxiliary-release 0.1.1')
    expect(pkg.scripts?.t7).toBe('node scripts/t7-lab.mjs')
    expect(pkg.devDependencies?.playwright).toBe('1.62.1')
    expect(pkg.dependencies ?? {}).not.toHaveProperty('playwright')
    expect(pkg.files).not.toEqual(expect.arrayContaining([expect.stringMatching(/playwright|scripts\//)]))
    expect(honestPollutionProbes()).toEqual({
      source: 'contract',
      window: 'clarify-only',
      transcript: 'unavailable',
      queue: 'unavailable',
      pending: 'unavailable',
      plan: 'unavailable',
      goal: 'unavailable',
    })
    expect(isT7LiveMain(import.meta.url, process.argv[1])).toBe(false)
    expect(isT7LiveMain(new URL('../scripts/t7-live.mjs', import.meta.url).href, join(root, 'scripts/t7-live.mjs'))).toBe(true)
  })

  it('forbids G0 writes, stripped keys, lab RPC, and non-Chromium browsers', () => {
    expect(FROZEN_G0_EVIDENCE).toEqual([
      'docs/t7-evidence/0.1.1-rc.2/t7.json',
      'docs/t7-evidence/0.1.1-rc.2/t7-report.md',
    ])
    expect(liveSource).not.toMatch(/stripProviderKeys/)
    expect(liveSource).not.toMatch(/session\.get|session\.current/)
    expect(liveSource).not.toMatch(/session\.prompt/)
    expect(liveSource).not.toMatch(/session\.create/)
    expect(liveSource).not.toMatch(/seedOfficialPublicSession/)
    expect(liveSource).not.toMatch(/callClarify/)
    expect(liveSource).not.toMatch(/writeFileSync|writeFile\(/)
    expect(liveSource).not.toMatch(/forceClick|\.click\([^)]*force/)
    expect(liveSource).not.toMatch(/t1T8VW/)
    expect(liveSource).not.toMatch(/settings\.mutate|credentials\.set/)
    expect(liveSource).not.toMatch(/getByText\(|press\('Escape'|press\('Esc'/)
    expect(liveSource).toMatch(/getByRole\('button'/)
    expect(liveSource).toMatch(/exact:\s*true/)
    expect(liveSource).toMatch(/state:\s*'hidden'/)
    expect(liveSource.lastIndexOf('locator.click')).toBeLessThan(liveSource.lastIndexOf("state: 'hidden'"))
    expect(liveSource).toMatch(/await send\.click[\s\S]{0,180}OFFICIAL_SEND_MISSING/)
    expect(liveSource).toMatch(/await composer\.click[\s\S]{0,180}liveBlockFromPointerFailure\(error\)/)
    expect(liveSource).toMatch(/dismissOfficialOnboarding/)
    expect(liveSource.lastIndexOf('await dismissOfficialOnboarding')).toBeLessThan(
      liveSource.lastIndexOf('await collectOfficialComposerCards'),
    )
    expect(liveSource).toMatch(/button, \[type="submit"\], \[role="button"\]/)
    expect(liveSource).not.toMatch(/card\.locator\(`\[aria-label=/)
    expect(liveSource).not.toMatch(/firefox|webkit/i)
    expect(liveSource).toMatch(/chromium/)
    expect(liveSource).not.toMatch(/\.fill\(|insertText/)
    expect(liveSource).toMatch(/Meta\+V|Control\+V/)
    expect(liveSource).not.toMatch(/\/message\|composer\|ask\|prompt\|chat\/i/)
    expect(liveSource).not.toMatch(/\/send\|submit\/i/)
    expect(liveSource).toMatch(/workspace\.create/)
    expect(liveSource).not.toMatch(/console\.[a-z]+\([^)]*(OPENAI_API_KEY|DEEPSEEK_API_KEY)/)
    expect(liveSource).not.toMatch(/plugin[^.\n]*seektty|seektty[^.\n]*add/i)
    expect(liveSource).not.toMatch(/resolveT7Assets\(parsed,\s*hooks\)/)
    expect(liveSource).toMatch(/hooks\.assetIo/)
    expect(liveSource).toMatch(/sanitizeLiveStdout\(doc\)/)
    expect(liveSource).not.toMatch(/JSON\.stringify\(doc/)
    expect(liveSource).not.toMatch(/allowOfficialSendRpc\s*=\s*true/)
    expect(liveSource).toMatch(/armOfficialSendGate/)
    expect(liveSource).toMatch(/waitOfficialSendEnabled/)
    expect(liveSource.indexOf("new URL('/', origin)")).toBeGreaterThan(-1)
    expect(liveSource.split("new URL('/', origin)")).toHaveLength(2)
    expect(liveSource).not.toMatch(/\.reload\(/)
    expect(liveSource.indexOf('const officialPage')).toBeLessThan(liveSource.indexOf('const diyPage'))
    expect(liveSource.lastIndexOf('attachNetwork(officialPage')).toBeLessThan(liveSource.indexOf('officialPage.goto'))
    expect(liveSource.indexOf('officialPage.goto')).toBeLessThan(liveSource.indexOf('diyPage.goto'))
    expect(liveSource.indexOf('diyPage.goto')).toBeLessThan(liveSource.lastIndexOf('pasteThenOfficialSend(officialPage'))
    expect(liveSource.lastIndexOf('armOfficialSendGate')).toBeGreaterThan(liveSource.indexOf("new URL('/', origin)"))
    expect(liveSource.lastIndexOf('requireManualPasteProof')).toBeLessThan(liveSource.lastIndexOf('waitOfficialSendEnabled'))
    expect(liveSource.lastIndexOf('waitOfficialSendEnabled')).toBeLessThan(liveSource.lastIndexOf('armOfficialSendGate'))
    expect(liveSource.lastIndexOf('armOfficialSendGate')).toBeLessThan(liveSource.lastIndexOf('.click('))
    expect(liveSource).not.toMatch(/return \{[^}]*(clipboardText|composerText)/)
    expect(liveSource).not.toMatch(/console\.[a-z]+\([^)]*ambiguousLiveSeed/)
    expect(liveSource.split("'--dump-config'")).toHaveLength(2)
    expect(liveSource.indexOf("'--dump-config'")).toBeLessThan(liveSource.lastIndexOf('assertLiveRouteCredential'))
    expect(liveSource.lastIndexOf('assertLiveRouteCredential')).toBeLessThan(liveSource.lastIndexOf('spawnDsh('))
    expect(liveSource.lastIndexOf('spawnDsh(')).toBeLessThan(liveSource.lastIndexOf('withChromium('))
    expect(liveSource.lastIndexOf('withChromium(')).toBeLessThan(liveSource.indexOf("'#start'"))
    expect(liveSource).toMatch(/assertLiveRouteCredential\(dumpText/)
    expect(liveSource).not.toMatch(/isolatedHome\(/)
    expect(liveSource).toMatch(/withIsolatedT7LiveHome/)
    expect(liveSource).toMatch(/createIsolatedWorkspacePath\(home\)/)
    expect(liveSource).not.toMatch(/isOwnedT7LiveHome|removeOwnedT7LiveHome/)
    expect(liveSource).toMatch(/extractOfficialPromptReceipt/)
    expect(liveSource).toMatch(/waitOfficialPromptAdmission/)
    expect(liveSource).toMatch(/waitForPostSendProjection/)
    expect(liveSource).not.toMatch(/waitForSendTurns/)
    expect(liveSource).toMatch(/PROMPT_IN_FLIGHT/)
    expect(liveSource).toMatch(/PROMPT_REJECTED/)
    expect(liveSource).toMatch(/TURN_NOT_STARTED/)
    expect(liveSource).toMatch(/STEP_INCOMPLETE/)
    expect(liveSource).toMatch(/PROJECTION_UNAVAILABLE/)
    expect(liveSource.lastIndexOf('waitOfficialPromptAdmission')).toBeGreaterThan(
      liveSource.lastIndexOf('pasteThenOfficialSend'),
    )
    expect(liveSource.lastIndexOf('waitForPostSendProjection')).toBeGreaterThan(
      liveSource.lastIndexOf('waitOfficialPromptAdmission'),
    )
    expect(liveSource).toMatch(/await pasteThenOfficialSend[\s\S]{0,240}await waitOfficialPromptAdmission[\s\S]{0,240}waitForPostSendProjection/)
    expect(liveSource).toMatch(/type === 'server-response'/)
    expect(liveSource).toMatch(/accepted === true/)
  })
})

describe('t7-live official prompt receipt and post-send phases', () => {
  it('forms a safe receipt only for /api/session.prompt with a typed server-response', () => {
    const accepted = extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-response',
      result: {
        ok: true,
        value: {
          accepted: true,
          sessionId: 'sess-secret',
          draft: 'secret draft',
          token: 'tok-secret',
        },
      },
    })
    expect(accepted).toEqual({
      kind: 'official-prompt',
      responded: true,
      accepted: true,
    })
    expect(Object.keys(accepted).sort()).toEqual(['accepted', 'kind', 'responded'])
    expect(JSON.stringify(accepted)).not.toMatch(/sess-secret|secret draft|tok-secret/)

    const rejected = extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-response',
      result: {
        ok: false,
        error: {
          code: 'agent-busy',
          message: 'provider exploded with sk-secret',
        },
      },
    })
    expect(rejected).toEqual({
      kind: 'official-prompt',
      responded: true,
      accepted: false,
    })
    expect(JSON.stringify(rejected)).not.toMatch(/provider exploded|sk-secret|agent-busy|sess-secret/)

    expect(extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-response',
      result: { ok: true, value: { accepted: false } },
    })?.accepted).toBe(false)
    expect(extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-response',
      result: { ok: true, value: {} },
    })?.accepted).toBe(false)
    expect(extractOfficialPromptReceipt('/api/session/sess-secret/prompt', {
      type: 'server-response',
      result: { ok: true, value: { accepted: true } },
    })).toBeUndefined()
    expect(extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-error',
      result: { ok: true, value: { accepted: true } },
    })).toBeUndefined()
    expect(extractOfficialPromptReceipt('/api/session.prompt', {
      type: 'server-response',
      result: { ok: 'true', value: { accepted: true } },
    })).toBeUndefined()
    expect(extractOfficialPromptReceipt('/api/clarify/start', {
      type: 'server-response',
      result: { ok: true, value: { accepted: true } },
    })).toBeUndefined()
  })

  it('distinguishes in-flight, rejected, and accepted admissions after exactly one request', () => {
    const armed = armOfficialSendGate(createOfficialSendGate())
    const once = noteOfficialSendAttempt(armed)
    expect(deriveOfficialPromptAdmission(once)).toEqual({
      ok: false,
      code: 'PROMPT_IN_FLIGHT',
      category: 'environment',
    })
    expect(deriveOfficialPromptAdmission(noteOfficialPromptResponse(once, {
      responded: true,
      accepted: false,
    }))).toEqual({
      ok: false,
      code: 'PROMPT_REJECTED',
      category: 'rpc',
    })
    expect(deriveOfficialPromptAdmission(noteOfficialPromptResponse(once, {
      responded: true,
      accepted: true,
    }))).toEqual({
      ok: true,
      accepted: true,
    })
    const firstRejected = noteOfficialPromptResponse(once, { responded: true, accepted: false })
    const ignoredSecond = noteOfficialPromptResponse(firstRejected, { responded: true, accepted: true })
    expect(deriveOfficialPromptAdmission(ignoredSecond).code).toBe('PROMPT_REJECTED')
    expect(deriveOfficialPromptAdmission(noteOfficialPromptResponse(armed, {
      responded: true,
      accepted: true,
    })).code).toBe('OFFICIAL_SEND_MISSING')
  })

  it('classifies post-send list phases without treating accepted or blank-only as full proof', () => {
    const postCall = { sessionCount: publicCount('one') }
    expect(classifyPostSendPhase(snap(true, false), postCall, 'turn-start')).toEqual({
      ok: false,
      code: 'TURN_NOT_STARTED',
      category: 'snapshot',
    })
    expect(classifyPostSendPhase(snap(false, false), postCall, 'turn-start')).toEqual({
      ok: true,
      phase: 'turn-started',
    })
    expect(classifyPostSendPhase(snap(false, false), postCall, 'step-end')).toEqual({
      ok: false,
      code: 'STEP_INCOMPLETE',
      category: 'snapshot',
    })
    expect(classifyPostSendPhase(snap(false, true), postCall, 'step-end')).toEqual({
      ok: true,
      phase: 'complete',
    })
    expect(classifyPostSendPhase(snap(true, false), postCall, 'step-end')).toEqual({
      ok: false,
      code: 'TURN_NOT_STARTED',
      category: 'snapshot',
    })
    expect(classifyPostSendPhase(snap(false, true, 'many'), postCall, 'step-end')).toEqual({
      ok: false,
      code: 'SESSION_SWITCHED',
      category: 'snapshot',
    })
    expect(classifyPostSendPhase({
      sessionCount: publicCount('one'),
      blankTurns: { available: false, status: 'unavailable' },
    }, postCall, 'turn-start')).toEqual({
      ok: false,
      code: 'PROJECTION_UNAVAILABLE',
      category: 'snapshot',
    })
    expect(classifyPostSendPhase({
      sessionCount: { available: false, status: 'unavailable' },
      blankTurns: { available: true, status: 'observed', blank: false, hasTurns: true },
    }, postCall, 'step-end')).toEqual({
      ok: false,
      code: 'PROJECTION_UNAVAILABLE',
      category: 'snapshot',
    })
  })

  it('waits for prompt admission and phased list proof with injectable clocks', async () => {
    const clock = fakeClock()
    const once = noteOfficialSendAttempt(armOfficialSendGate(createOfficialSendGate()))
    const network = { sendGate: once }
    await expect(waitOfficialPromptAdmission(network, {
      promptResponseTimeoutMs: 40,
      now: clock.now,
      delay: clock.delay,
    })).rejects.toMatchObject({ code: 'PROMPT_IN_FLIGHT', category: 'environment' })

    const rejected = { sendGate: noteOfficialPromptResponse(once, { responded: true, accepted: false }) }
    await expect(waitOfficialPromptAdmission(rejected, {
      promptResponseTimeoutMs: 40,
      now: fakeClock().now,
      delay: fakeClock().delay,
    })).rejects.toMatchObject({ code: 'PROMPT_REJECTED', category: 'rpc' })

    const arriving = { sendGate: once }
    const arriveClock = fakeClock()
    let polls = 0
    await expect(waitOfficialPromptAdmission(arriving, {
      promptResponseTimeoutMs: 200,
      now: arriveClock.now,
      delay: async (ms) => {
        polls += 1
        if (polls === 1) {
          arriving.sendGate = noteOfficialPromptResponse(arriving.sendGate, {
            responded: true,
            accepted: true,
          })
        }
        await arriveClock.delay(ms)
      },
    })).resolves.toEqual({ ok: true, accepted: true })

    const postCall = snap(true, false)
    const frames = [snap(true, false), snap(false, false), snap(false, true)]
    let index = 0
    const successClock = fakeClock()
    await expect(waitForPostSendProjection(async () => frames[Math.min(index++, frames.length - 1)], postCall, {
      turnStartTimeoutMs: 200,
      stepEndTimeoutMs: 200,
      pollIntervalMs: 10,
      now: successClock.now,
      delay: successClock.delay,
    })).resolves.toMatchObject({
      blankTurns: { blank: false, hasTurns: true },
    })

    const turnClock = fakeClock()
    await expect(waitForPostSendProjection(async () => snap(true, false), postCall, {
      turnStartTimeoutMs: 40,
      stepEndTimeoutMs: 40,
      pollIntervalMs: 10,
      now: turnClock.now,
      delay: turnClock.delay,
    })).rejects.toMatchObject({ code: 'TURN_NOT_STARTED', category: 'snapshot' })

    const stepClock = fakeClock()
    await expect(waitForPostSendProjection(async () => snap(false, false), postCall, {
      turnStartTimeoutMs: 40,
      stepEndTimeoutMs: 40,
      pollIntervalMs: 10,
      now: stepClock.now,
      delay: stepClock.delay,
    })).rejects.toMatchObject({ code: 'STEP_INCOMPLETE', category: 'snapshot' })

    const switchedClock = fakeClock()
    await expect(waitForPostSendProjection(async () => snap(false, true, 'many'), postCall, {
      turnStartTimeoutMs: 40,
      stepEndTimeoutMs: 40,
      pollIntervalMs: 10,
      now: switchedClock.now,
      delay: switchedClock.delay,
    })).rejects.toMatchObject({ code: 'SESSION_SWITCHED', category: 'snapshot' })

    let completeReads = 0
    const completeClock = fakeClock()
    await expect(waitForPostSendProjection(async () => {
      completeReads += 1
      return snap(false, true)
    }, postCall, {
      turnStartTimeoutMs: 200,
      stepEndTimeoutMs: 200,
      pollIntervalMs: 10,
      now: completeClock.now,
      delay: completeClock.delay,
    })).resolves.toMatchObject({
      blankTurns: { blank: false, hasTurns: true },
    })
    expect(completeReads).toBe(1)

    const recoverFrames = [unavailableSnap(), snap(false, false), snap(false, true)]
    let recoverIndex = 0
    const recoverClock = fakeClock()
    await expect(waitForPostSendProjection(async () => recoverFrames[Math.min(recoverIndex++, recoverFrames.length - 1)], postCall, {
      turnStartTimeoutMs: 200,
      stepEndTimeoutMs: 200,
      pollIntervalMs: 10,
      now: recoverClock.now,
      delay: recoverClock.delay,
    })).resolves.toMatchObject({
      blankTurns: { blank: false, hasTurns: true },
    })

    const afterTurnFrames = [snap(false, false), unavailableSnap()]
    let afterTurnIndex = 0
    const afterTurnClock = fakeClock()
    await expect(waitForPostSendProjection(async () => afterTurnFrames[Math.min(afterTurnIndex++, afterTurnFrames.length - 1)], postCall, {
      turnStartTimeoutMs: 40,
      stepEndTimeoutMs: 40,
      pollIntervalMs: 10,
      now: afterTurnClock.now,
      delay: afterTurnClock.delay,
    })).rejects.toMatchObject({ code: 'STEP_INCOMPLETE', category: 'snapshot' })

    const missingClock = fakeClock()
    await expect(waitForPostSendProjection(async () => unavailableSnap(), postCall, {
      turnStartTimeoutMs: 40,
      stepEndTimeoutMs: 40,
      pollIntervalMs: 10,
      now: missingClock.now,
      delay: missingClock.delay,
    })).rejects.toMatchObject({ code: 'PROJECTION_UNAVAILABLE', category: 'snapshot' })
  })

  it('clamps injectable post-send timeouts to a finite production upper bound', () => {
    expect(OFFICIAL_PROMPT_RESPONSE_TIMEOUT_MS).toBe(30_000)
    expect(OFFICIAL_TURN_START_TIMEOUT_MS).toBe(60_000)
    expect(OFFICIAL_STEP_END_TIMEOUT_MS).toBe(180_000)
    expect(OFFICIAL_POST_SEND_TIMEOUT_MAX_MS).toBe(180_000)
    expect(OFFICIAL_POST_SEND_POLL_INTERVAL_MS).toBe(500)
    expect(OFFICIAL_PROMPT_POLL_INTERVAL_MS).toBe(50)
    expect(OFFICIAL_STEP_END_TIMEOUT_MS).toBeLessThanOrEqual(OFFICIAL_POST_SEND_TIMEOUT_MAX_MS)
    expect(clampOfficialPostSendTimeout(999_999, OFFICIAL_STEP_END_TIMEOUT_MS)).toBe(OFFICIAL_POST_SEND_TIMEOUT_MAX_MS)
    expect(clampOfficialPostSendTimeout(0, OFFICIAL_PROMPT_RESPONSE_TIMEOUT_MS)).toBe(OFFICIAL_PROMPT_RESPONSE_TIMEOUT_MS)
    expect(clampOfficialPostSendTimeout(5_000, OFFICIAL_TURN_START_TIMEOUT_MS)).toBe(5_000)
  })
})

describe('t7-live attachNetwork official prompt listener', () => {
  it('accepts and rejects only the counted /api/session.prompt server-response', async () => {
    const happy = createNetworkProbe()
    attachNetwork(happy.page, happy.network)
    happy.network.sendGate = armOfficialSendGate(happy.network.sendGate)
    const counted = fakePlaywrightRequest('http://127.0.0.1:9/api/session.prompt')
    await happy.page.emit('request', counted)
    await happy.page.emit('response', fakePlaywrightResponse(counted, {
      json: officialPromptEnvelope(true, { sessionId: 'sess-secret', draft: 'secret draft' }),
    }))
    expect(deriveOfficialPromptAdmission(happy.network.sendGate)).toEqual({ ok: true, accepted: true })
    expect(JSON.stringify(happy.network.sendGate)).not.toMatch(/sess-secret|secret draft/)

    const rejected = createNetworkProbe()
    attachNetwork(rejected.page, rejected.network)
    rejected.network.sendGate = armOfficialSendGate(rejected.network.sendGate)
    const rejectedReq = fakePlaywrightRequest('http://127.0.0.1:9/api/session.prompt')
    await rejected.page.emit('request', rejectedReq)
    await rejected.page.emit('response', fakePlaywrightResponse(rejectedReq, {
      json: {
        type: 'server-response',
        result: { ok: false, error: { code: 'agent-busy', message: 'provider exploded with sk-secret' } },
      },
    }))
    expect(deriveOfficialPromptAdmission(rejected.network.sendGate)).toEqual({
      ok: false,
      code: 'PROMPT_REJECTED',
      category: 'rpc',
    })
    expect(JSON.stringify(rejected.network.sendGate)).not.toMatch(/provider exploded|sk-secret|agent-busy/)
  })

  it('ignores REST, non-2xx, non-JSON, bad type, and responses for uncounted requests', async () => {
    const cases = [
      {
        url: 'http://127.0.0.1:9/api/session/sess-secret/prompt',
        json: officialPromptEnvelope(true),
      },
      {
        url: 'http://127.0.0.1:9/api/session.prompt',
        ok: false,
        json: officialPromptEnvelope(true),
      },
      {
        url: 'http://127.0.0.1:9/api/session.prompt',
        jsonError: true,
      },
      {
        url: 'http://127.0.0.1:9/api/session.prompt',
        json: { type: 'server-error', result: { ok: true, value: { accepted: true } } },
      },
    ]
    for (const item of cases) {
      const probe = createNetworkProbe()
      attachNetwork(probe.page, probe.network)
      probe.network.sendGate = armOfficialSendGate(probe.network.sendGate)
      const counted = fakePlaywrightRequest(item.url)
      await probe.page.emit('request', counted)
      await probe.page.emit('response', fakePlaywrightResponse(counted, item))
      expect(deriveOfficialPromptAdmission(probe.network.sendGate)).toEqual({
        ok: false,
        code: 'PROMPT_IN_FLIGHT',
        category: 'environment',
      })
    }

    const shared = createNetworkProbe()
    const otherPage = fakePlaywrightPage()
    attachNetwork(shared.page, shared.network)
    attachNetwork(otherPage, shared.network)
    shared.network.sendGate = armOfficialSendGate(shared.network.sendGate)
    const counted = fakePlaywrightRequest('http://127.0.0.1:9/api/session.prompt')
    const stranger = fakePlaywrightRequest('http://127.0.0.1:9/api/session.prompt')
    await shared.page.emit('request', counted)
    await otherPage.emit('response', fakePlaywrightResponse(stranger, {
      json: officialPromptEnvelope(true, { sessionId: 'sess-other' }),
    }))
    expect(deriveOfficialPromptAdmission(shared.network.sendGate)).toEqual({
      ok: false,
      code: 'PROMPT_IN_FLIGHT',
      category: 'environment',
    })
    await shared.page.emit('response', fakePlaywrightResponse(counted, {
      json: officialPromptEnvelope(true),
    }))
    expect(deriveOfficialPromptAdmission(shared.network.sendGate)).toEqual({ ok: true, accepted: true })
    expect(JSON.stringify(shared.network.sendGate)).not.toMatch(/sess-other/)
  })
})

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    delay: async (ms: number) => {
      t += Number(ms) || 1
    },
  }
}

function publicCount(band = 'one') {
  return { available: true, status: 'observed', band }
}

function snap(blank: boolean, hasTurns: boolean, band = 'one') {
  return {
    sessionCount: publicCount(band),
    blankTurns: { available: true, status: 'observed', blank, hasTurns },
  }
}

function unavailableSnap(band = 'one') {
  return {
    sessionCount: publicCount(band),
    blankTurns: { available: false, status: 'unavailable' },
  }
}

function officialPromptEnvelope(accepted: boolean, extra: Record<string, unknown> = {}) {
  return {
    type: 'server-response',
    result: {
      ok: accepted,
      value: { accepted, ...extra },
    },
  }
}

function fakePlaywrightPage() {
  const listeners = new Map<string, Array<(arg: unknown) => unknown>>()
  return {
    on(event: string, fn: (arg: unknown) => unknown) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    async emit(event: string, arg: unknown) {
      for (const fn of listeners.get(event) ?? []) await fn(arg)
    },
  }
}

function fakePlaywrightRequest(url: string) {
  return {
    method: () => 'POST',
    url: () => url,
  }
}

function fakePlaywrightResponse(request: { method: () => string, url: () => string }, options: {
  ok?: boolean
  json?: unknown
  jsonError?: boolean
  url?: string
}) {
  return {
    ok: () => options.ok !== false,
    request: () => request,
    url: () => options.url ?? request.url(),
    json: async () => {
      if (options.jsonError) throw new Error('not json')
      return options.json
    },
  }
}

function createNetworkProbe() {
  return {
    page: fakePlaywrightPage(),
    network: { events: [], sendGate: createOfficialSendGate(), blocked: null as { code: string, category: string } | null },
  }
}

function agentDefaultModelDump(provider: string) {
  return [
    '# == @deepseek-ai/dsh-agent-default-model',
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    `    provider: ${provider}`,
    '    model: deepseek-v4-flash',
    '    searchProvider: deepseek-official',
  ].join('\n')
}

function decoyDump(provider: string) {
  return [
    '# == @deepseek-ai/dsh-llm-pi-ai',
    '- id: llm',
    '  config:',
    '    provider: openai',
    '    searchProvider: openai',
    agentDefaultModelDump(provider),
    '- id: other',
    '  provider: openai',
  ].join('\n')
}

function composerCard(overrides: Record<string, unknown> = {}) {
  return {
    card: true,
    visible: true,
    cardIndex: 0,
    textareas: [writableTextarea()],
    sends: [officialSend('Send message')],
    ...overrides,
  }
}

function writableTextarea(overrides: Record<string, unknown> = {}) {
  return {
    tag: 'textarea',
    disabled: false,
    readOnly: false,
    dataPhase: 'hero',
    ariaLabel: '',
    visible: true,
    index: 0,
    ...overrides,
  }
}

function officialSend(ariaLabel: string, overrides: Record<string, unknown> = {}) {
  return {
    ariaLabel,
    disabled: true,
    index: 0,
    ...overrides,
  }
}

function expectSafeRouteResult(value: unknown, dump?: string) {
  const serialized = `${JSON.stringify(value)}\n${value instanceof Error ? value.message : String(value)}`
  expect(serialized).not.toMatch(/deepseek-official|deepseek-v4-flash|# ==/i)
  expect(serialized).not.toMatch(/OPENAI_API_KEY|DEEPSEEK_API_KEY|sk-unrelated|sk-secret/)
  expect(serialized).not.toMatch(/"provider"|"model"|"searchProvider"|"dump"|"env"/)
  if (dump) expect(serialized).not.toContain(dump)
  if (value && typeof value === 'object' && !(value instanceof Error)) {
    for (const key of Object.keys(value)) {
      expect(['ok', 'code', 'category', 'launchBrowser', 'bootHost', 'callProvider', 'block']).toContain(key)
    }
    expect(value).not.toHaveProperty('provider')
    expect(value).not.toHaveProperty('model')
    expect(value).not.toHaveProperty('env')
    expect(value).not.toHaveProperty('dump')
    expect(value).not.toHaveProperty('value')
  }
}

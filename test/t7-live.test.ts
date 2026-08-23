import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  assertLiveRouteCredential,
  canAdvanceDiyJourney,
  classifyLiveEndpoint,
  classifyRouteCredential,
  classifyStartPreflight,
  comparePastedComposer,
  createDiyJourneyMachine,
  createOfficialSendGate,
  deriveManualDraftTransfer,
  deriveOfficialSendReceipts,
  expectedDiyMethod,
  extractClarifyReceipt,
  formatBlockedOutput,
  formatLiveSuccessStdout,
  honestPollutionProbes,
  invokeDiyStep,
  isT7LiveMain,
  liveAssetIo,
  liveJourneyReceipts,
  noteOfficialSendAttempt,
  observeCredentialPresence,
  officialPasteShortcut,
  parseT7LiveArgs,
  planLiveRun,
  planRouteDispatch,
  requireManualPasteProof,
  resolveLiveAssets,
  runT7Live,
  sanitizeLiveStdout,
  selectDiyAnswerAction,
  selectOfficialComposer,
} from '../scripts/t7-live.mjs'

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

  it('fails closed unless exactly one semantic composer and one send control exist', () => {
    expect(selectOfficialComposer([]).ok).toBe(false)
    expect(selectOfficialComposer([])).toMatchObject({
      code: 'COMPOSER_UNIDENTIFIED',
      category: 'operator',
    })
    expect(selectOfficialComposer([
      { tag: 'textarea', role: 'textbox', ariaLabel: 'Message composer' },
      { tag: 'button', role: 'button', ariaLabel: 'Send message' },
    ]).ok).toBe(true)
    expect(selectOfficialComposer([
      { tag: 'textarea', role: 'textbox', ariaLabel: 'Message composer' },
      { tag: 'textarea', role: 'textbox', ariaLabel: 'Ask a follow-up' },
      { tag: 'button', role: 'button', ariaLabel: 'Send' },
    ]).ok).toBe(false)
    expect(selectOfficialComposer([
      { tag: 'input', role: 'searchbox', ariaLabel: 'Search settings' },
      { tag: 'button', role: 'button', ariaLabel: 'Settings' },
    ]).ok).toBe(false)
    expect(officialPasteShortcut('darwin')).toBe('Meta+V')
    expect(officialPasteShortcut('linux')).toBe('Control+V')
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
    expect(liveSource).not.toMatch(/callClarify/)
    expect(liveSource).not.toMatch(/writeFileSync|writeFile\(/)
    expect(liveSource).not.toMatch(/firefox|webkit/i)
    expect(liveSource).toMatch(/chromium/)
    expect(liveSource).not.toMatch(/\.fill\(|insertText/)
    expect(liveSource).toMatch(/Meta\+V|Control\+V/)
    expect(liveSource).not.toMatch(/console\.[a-z]+\([^)]*(OPENAI_API_KEY|DEEPSEEK_API_KEY)/)
    expect(liveSource).not.toMatch(/plugin[^.\n]*seektty|seektty[^.\n]*add/i)
    expect(liveSource).not.toMatch(/resolveT7Assets\(parsed,\s*hooks\)/)
    expect(liveSource).toMatch(/hooks\.assetIo/)
    expect(liveSource).toMatch(/sanitizeLiveStdout\(doc\)/)
    expect(liveSource).not.toMatch(/JSON\.stringify\(doc/)
    expect(liveSource).not.toMatch(/allowOfficialSendRpc\s*=\s*true/)
    expect(liveSource).toMatch(/armOfficialSendGate/)
    expect(liveSource.indexOf("new URL('/', origin)")).toBeGreaterThan(-1)
    expect(liveSource.lastIndexOf('armOfficialSendGate')).toBeGreaterThan(liveSource.indexOf("new URL('/', origin)"))
    expect(liveSource).not.toMatch(/return \{[^}]*(clipboardText|composerText)/)
    expect(liveSource).not.toMatch(/console\.[a-z]+\([^)]*ambiguousLiveSeed/)
    expect(liveSource.split("'--dump-config'")).toHaveLength(2)
    expect(liveSource.indexOf("'--dump-config'")).toBeLessThan(liveSource.lastIndexOf('assertLiveRouteCredential'))
    expect(liveSource.lastIndexOf('assertLiveRouteCredential')).toBeLessThan(liveSource.lastIndexOf('spawnDsh('))
    expect(liveSource.lastIndexOf('spawnDsh(')).toBeLessThan(liveSource.lastIndexOf('withChromium('))
    expect(liveSource.lastIndexOf('withChromium(')).toBeLessThan(liveSource.indexOf("'#start'"))
    expect(liveSource).toMatch(/assertLiveRouteCredential\(dumpText/)
  })
})

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

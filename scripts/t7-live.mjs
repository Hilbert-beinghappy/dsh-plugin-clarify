#!/usr/bin/env node
// t7-live --from-release --require-local-assets --clarify-release 0.2.2 --auxiliary-release 0.1.1
// Independent live entry. Never strip keys. Default no write. Chromium only.
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  T7_DIY_METHODS,
  T7_REQUIRED_COMPARISON_KEYS,
  buildT7Document,
  comparisonState,
  formatT7Report,
  isFullT7,
  parseT7LabArgs,
  sanitizeT7Document,
  validateT7Document,
} from './lib/t7-schema.mjs'
import {
  assertExactDshVersion,
  createIsolatedWorkspacePath,
  detectStartSignals,
  inspectDiySurface,
  labelOfficialPublicSession,
  observeSeekTtyInstalled,
  resolveT7Assets,
  seedOfficialPublicSession,
  snapshotImmediateBeforeFirstClarifyRpc,
  takePublicSnapshot,
} from './lib/t7-surfaces.mjs'
import {
  ensureOfficialDsh,
  isolatedHome,
  runDsh,
  spawnDsh,
  stopChild,
  waitForPrintedOrigin,
} from './lib/harness.mjs'
import { postApi } from './lib/remote-client.mjs'
import { sanitizeText } from './lib/sanitize.mjs'

const PROVIDER_KEY_VENDORS = ['OPENAI', 'DEEPSEEK']
const COMPOSER_HINT = /message|composer|ask|prompt|chat/i
const SEND_HINT = /send|submit/i
const REJECT_HINT = /search|settings|filter|clarify|seed|session|feedback|custom/i

export const FROZEN_G0_EVIDENCE = Object.freeze([
  'docs/t7-evidence/0.1.1-rc.2/t7.json',
  'docs/t7-evidence/0.1.1-rc.2/t7-report.md',
])

export const DIY_LIVE_STEPS = Object.freeze([
  { id: 'startA', process: 'A', method: 'start', preflight: true },
  { id: 'cancelA', process: 'A', method: 'cancel' },
  { id: 'startB', process: 'B', method: 'start', requireAsk: true },
  { id: 'answerB', process: 'B', method: 'answer' },
  { id: 'refineB', process: 'B', method: 'refine' },
  { id: 'acceptB', process: 'B', method: 'accept' },
  { id: 'fetchB', process: 'B', method: 'fetchDraft' },
  { id: 'copyB', process: 'B', method: 'copy', network: false },
])

export class LiveBlock extends Error {
  constructor(code, category) {
    super(`${code} ${category}`)
    this.name = 'LiveBlock'
    this.code = code
    this.category = category
  }
}

export function formatBlockedOutput(code, category) {
  return `${code} ${category}`
}

export function officialSendMethod() {
  return ['session', 'prompt'].join('.')
}

export function parseT7LiveArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  if (args.includes('--validate') || args.includes('--from-pack')) {
    throw new LiveBlock('UNSUPPORTED_MODE', 'argv')
  }
  if (args.includes('--write')) {
    throw new LiveBlock('WRITE_REFUSED', 'argv')
  }
  if (!args.includes('--from-release')) {
    throw new LiveBlock('FROM_RELEASE_REQUIRED', 'argv')
  }
  try {
    const parsed = parseT7LabArgs(args)
    return { ...parsed, write: false }
  } catch (error) {
    throw new LiveBlock(classifyArgvError(error), 'argv')
  }
}

export function observeCredentialPresence(env = {}) {
  const present = providerKeyNames().some((name) => {
    const raw = env[name]
    return typeof raw === 'string' && raw.length > 0
  })
  return { present }
}

export function planLiveRun({ presence } = {}) {
  if (presence?.present !== true) {
    return {
      launchBrowser: false,
      bootHost: false,
      callProvider: false,
      block: { code: 'MISSING_CREDENTIAL', category: 'preflight' },
    }
  }
  return {
    launchBrowser: true,
    bootHost: true,
    callProvider: true,
    block: null,
  }
}

export function classifyRouteCredential(dumpText, env = {}) {
  const providerId = readAgentDefaultModelProvider(dumpText)
  const required = providerId ? OFFICIAL_ROUTE_ENV[providerId] : undefined
  if (!required) {
    return { ok: false, code: 'ROUTE_CREDENTIAL_UNKNOWN', category: 'preflight' }
  }
  const raw = env[required]
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, code: 'ROUTE_CREDENTIAL_MISMATCH', category: 'preflight' }
  }
  return { ok: true }
}

export function assertLiveRouteCredential(dumpText, env = {}) {
  const classified = classifyRouteCredential(dumpText, env)
  if (classified.ok !== true) {
    throw new LiveBlock(classified.code, classified.category)
  }
  return classified
}

export function planRouteDispatch(classified = {}) {
  if (classified.ok === true) {
    return {
      launchBrowser: true,
      bootHost: true,
      callProvider: true,
      block: null,
    }
  }
  return {
    launchBrowser: false,
    bootHost: false,
    callProvider: false,
    block: {
      code: classified.code === 'ROUTE_CREDENTIAL_MISMATCH' ? 'ROUTE_CREDENTIAL_MISMATCH' : 'ROUTE_CREDENTIAL_UNKNOWN',
      category: 'preflight',
    },
  }
}

export function classifyStartPreflight(event = {}) {
  if (event.ok === true && event.status === 'running' && (event.kind === 'ask' || event.kind === 'await_accept')) {
    if (event.kind === 'ask' && event.hasQuestion !== true) {
      return { ok: false, code: 'START_NO_QUESTION', category: 'configuration' }
    }
    return { ok: true, code: 'START_READY', category: 'preflight' }
  }
  if (event.providerFailureCode === 'MISSING_CREDENTIAL') {
    return { ok: false, code: 'MISSING_CREDENTIAL', category: 'preflight' }
  }
  if (event.providerFailureCode === 'ENOTSUP') {
    return { ok: false, code: 'ENOTSUP', category: 'preflight' }
  }
  if (event.errorCode === 'INFERENCE_UNAVAILABLE') {
    return { ok: false, code: 'INFERENCE_UNAVAILABLE', category: 'preflight' }
  }
  return { ok: false, code: 'START_CONFIGURATION', category: 'configuration' }
}

export function createDiyJourneyMachine() {
  return {
    stepIndex: 0,
    status: 'ready',
    stopReason: undefined,
    stopCategory: undefined,
    methods: Object.fromEntries(T7_DIY_METHODS.map((name) => [name, 'unavailable'])),
    copied: false,
    sessionPromptSeen: false,
    cancelRecovery: { observed: false, cancelled: false, recovered: false },
  }
}

export function expectedDiyMethod(machine) {
  return DIY_LIVE_STEPS[machine?.stepIndex]?.method
}

export function applyDiyJourneyEvent(machine, event = {}) {
  if (!machine || machine.status === 'blocked' || machine.status === 'complete') return machine
  if (event.kind === officialSendMethod() || event.method === officialSendMethod()) {
    return {
      ...machine,
      status: 'blocked',
      stopReason: 'SESSION_PROMPT',
      stopCategory: 'forbidden',
      sessionPromptSeen: true,
    }
  }
  const step = DIY_LIVE_STEPS[machine.stepIndex]
  if (!step) {
    return { ...machine, status: 'blocked', stopReason: 'SEQUENCE_OVERFLOW', stopCategory: 'runner' }
  }
  if (event.method !== step.method) {
    return { ...machine, status: 'blocked', stopReason: 'UNEXPECTED_METHOD', stopCategory: 'sequence' }
  }
  if (step.preflight === true) {
    const preflight = classifyStartPreflight(event)
    if (preflight.ok !== true) {
      return {
        ...machine,
        status: 'blocked',
        stopReason: preflight.code,
        stopCategory: preflight.category,
        methods: { ...machine.methods, start: 'failed' },
      }
    }
  } else if (step.method !== 'copy' && event.ok !== true) {
    return {
      ...machine,
      status: 'blocked',
      stopReason: event.errorCode || 'METHOD_FAILED',
      stopCategory: 'rpc',
    }
  }
  if (step.requireAsk === true) {
    if (event.kind !== 'ask') {
      return {
        ...machine,
        status: 'blocked',
        stopReason: 'START_NOT_ASK',
        stopCategory: 'configuration',
      }
    }
    if (event.hasQuestion !== true) {
      return {
        ...machine,
        status: 'blocked',
        stopReason: 'START_NO_QUESTION',
        stopCategory: 'configuration',
      }
    }
  }
  const methods = { ...machine.methods }
  if (step.method !== 'copy') methods[step.method] = 'succeeded'
  const cancelRecovery = { ...machine.cancelRecovery }
  if (step.method === 'cancel' && event.ok === true) {
    cancelRecovery.observed = true
    cancelRecovery.cancelled = true
  }
  if (step.id === 'startB' && event.ok === true && cancelRecovery.cancelled === true) {
    cancelRecovery.observed = true
    cancelRecovery.recovered = true
  }
  const nextIndex = machine.stepIndex + 1
  return {
    ...machine,
    stepIndex: nextIndex,
    status: nextIndex >= DIY_LIVE_STEPS.length ? 'complete' : 'ready',
    methods,
    copied: step.method === 'copy' ? event.ok === true : machine.copied,
    cancelRecovery,
  }
}

export function applyDiyJourneySequence(events, machine = createDiyJourneyMachine()) {
  let current = machine
  for (const event of events ?? []) {
    current = applyDiyJourneyEvent(current, event)
  }
  return current
}

export function canAdvanceDiyJourney(machine) {
  return Boolean(machine) && machine.status !== 'blocked' && machine.status !== 'complete'
}

export function invokeDiyStep(machine, fn) {
  if (!canAdvanceDiyJourney(machine)) return { machine, invoked: false }
  return { machine: fn(machine), invoked: true }
}

export function selectDiyAnswerAction(surface = {}) {
  const optionCount = Number(surface.optionCount)
  if (Number.isInteger(optionCount) && optionCount > 0) {
    return { ok: true, action: 'first-option' }
  }
  if (surface.allowCustom === true) {
    return { ok: true, action: 'custom' }
  }
  return { ok: false, code: 'ANSWER_UNAVAILABLE', category: 'configuration' }
}

export function comparePastedComposer(clipboardText, composerText) {
  const clip = typeof clipboardText === 'string' ? clipboardText : ''
  const composer = typeof composerText === 'string' ? composerText : ''
  return {
    nonEmpty: clip.length > 0 && composer.length > 0,
    exactMatch: clip.length > 0 && clip === composer,
  }
}

export function deriveManualDraftTransfer(proof = {}) {
  return {
    observed: proof?.nonEmpty === true && proof?.exactMatch === true,
    method: 'manual-paste',
    autoFilled: false,
  }
}

export function requireManualPasteProof(proof) {
  const transfer = deriveManualDraftTransfer(proof)
  if (transfer.observed !== true) {
    throw new LiveBlock('PASTE_MISMATCH', 'operator')
  }
  return transfer
}

export function createOfficialSendGate() {
  return { armed: false, officialSendCount: 0, premature: false }
}

export function armOfficialSendGate(gate = createOfficialSendGate()) {
  return { ...gate, armed: true }
}

export function noteOfficialSendAttempt(gate = createOfficialSendGate()) {
  if (gate.armed !== true) {
    return { ...gate, premature: true }
  }
  return { ...gate, officialSendCount: (gate.officialSendCount ?? 0) + 1 }
}

export function deriveOfficialSendReceipts(gate = createOfficialSendGate()) {
  if (gate.premature === true) {
    return {
      ok: false,
      code: 'SESSION_PROMPT',
      category: 'forbidden',
      officialComposerSend: { observed: false, channel: 'official-web-composer' },
      pluginAutoSent: true,
      userSent: false,
    }
  }
  if (gate.armed !== true || gate.officialSendCount !== 1) {
    return {
      ok: false,
      code: gate.officialSendCount > 1 ? 'OFFICIAL_SEND_COUNT' : 'OFFICIAL_SEND_MISSING',
      category: 'operator',
      officialComposerSend: { observed: false, channel: 'official-web-composer' },
      pluginAutoSent: false,
      userSent: false,
    }
  }
  return {
    ok: true,
    officialComposerSend: { observed: true, channel: 'official-web-composer' },
    pluginAutoSent: false,
    userSent: true,
  }
}

export function liveJourneyReceipts({ pasteProof, sendGate } = {}) {
  const manualDraftTransfer = deriveManualDraftTransfer(pasteProof)
  const send = deriveOfficialSendReceipts(sendGate)
  return {
    draftManuallyPasted: manualDraftTransfer.observed === true,
    userSent: send.userSent === true,
    pluginAutoSent: send.pluginAutoSent === true,
    manualDraftTransfer,
    officialComposerSend: send.officialComposerSend,
    sendOk: send.ok === true && manualDraftTransfer.observed === true,
    sendBlock: send.ok === true ? null : { code: send.code, category: send.category },
    pasteBlock: manualDraftTransfer.observed === true ? null : { code: 'PASTE_MISMATCH', category: 'operator' },
  }
}

export function ambiguousLiveSeed() {
  return 'A or B? pick 1'
}

export function liveAssetIo(hooks = {}) {
  const io = hooks.assetIo
  if (!io || typeof io !== 'object') return undefined
  return io
}

export function resolveLiveAssets(parsed, hooks = {}) {
  const io = liveAssetIo(hooks)
  return io ? resolveT7Assets(parsed, io) : resolveT7Assets(parsed)
}

export function formatLiveSuccessStdout(doc, report) {
  const printedDoc = JSON.stringify(sanitizeLiveStdout(doc), null, 2)
  const printedReport = typeof report === 'string'
    ? sanitizeLiveStdout(report)
    : JSON.stringify(sanitizeLiveStdout(report), null, 2)
  return `${printedDoc}\n${printedReport}`
}

export function classifyLiveEndpoint(urlPath) {
  const path = String(urlPath ?? '')
  if (/session[./]prompt/.test(path)) {
    return { kind: 'forbidden', method: officialSendMethod() }
  }
  const clarify = path.match(/\/api\/clarify\/(start|answer|accept|refine|cancel|fetchDraft)/)
  if (clarify) return { kind: 'clarify', method: clarify[1] }
  if (/\/api\/session\.list\b/.test(path)) return { kind: 'public', method: 'session.list' }
  return { kind: 'other' }
}

export function extractClarifyReceipt(pathname, json) {
  const classified = classifyLiveEndpoint(pathname)
  if (classified.kind !== 'clarify') return undefined
  const outer = json?.result
  const wire = outer?.value
  const wireOk = outer?.ok === true && wire?.protocol === 'clarify.wire/1' && wire?.ok === true
  const value = wireOk ? wire.value : undefined
  const error = (wire && wire.ok === false ? wire.error : undefined)
    || (outer?.ok === false ? outer.error : undefined)
  const signals = detectStartSignals({ ok: wireOk === true, error })
  const receipt = {
    method: classified.method,
    ok: wireOk === true,
  }
  if (typeof value?.status === 'string') receipt.status = value.status
  if (typeof value?.kind === 'string') receipt.kind = value.kind
  if (classified.method === 'start') receipt.hasQuestion = value?.question != null
  if (receipt.ok !== true) {
    if (typeof error?.code === 'string') receipt.errorCode = error.code
    else if (signals.errorCode && signals.errorCode !== 'absent') receipt.errorCode = signals.errorCode
    if (signals.providerFailureCode && signals.providerFailureCode !== 'UNKNOWN') {
      receipt.providerFailureCode = signals.providerFailureCode
    }
  }
  return receipt
}

export function honestPollutionProbes() {
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

export function sanitizeLiveStdout(value) {
  if (typeof value === 'string') return redactLiveSeed(sanitizeText(value))
  return redactLiveSeedDeep(sanitizeT7Document(stripLiveOnlyKeys(value)))
}

export function officialPasteShortcut(platform = process.platform) {
  return platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

export function selectOfficialComposer(nodes = []) {
  const composers = []
  const sends = []
  for (const node of nodes) {
    const text = controlText(node)
    if (REJECT_HINT.test(text)) continue
    if (isComposerField(node) && COMPOSER_HINT.test(text)) composers.push(node)
    else if (isSendControl(node) && SEND_HINT.test(text)) sends.push(node)
  }
  if (composers.length !== 1 || sends.length !== 1) {
    return { ok: false, code: 'COMPOSER_UNIDENTIFIED', category: 'operator' }
  }
  return { ok: true, composer: composers[0], send: sends[0] }
}

export function isT7LiveMain(metaUrl, argv1 = process.argv[1]) {
  if (!metaUrl || !argv1) return false
  try {
    return fileURLToPath(metaUrl) === resolve(argv1)
  } catch {
    return false
  }
}

export async function runT7Live(argv = process.argv.slice(2), hooks = {}) {
  const env = hooks.env ?? process.env
  const parsed = parseT7LiveArgs(argv)
  const presence = observeCredentialPresence(env)
  const plan = planLiveRun({ presence })
  if (plan.block) throw new LiveBlock(plan.block.code, plan.block.category)
  let asset
  try {
    asset = resolveLiveAssets(parsed, hooks)
  } catch (error) {
    if (error instanceof LiveBlock) throw error
    throw new LiveBlock('ASSETS', 'release')
  }
  if (asset.mode !== 'from-release' || asset.checksumVerified !== true) {
    throw new LiveBlock('ASSETS', 'release')
  }
  if (typeof hooks.execute === 'function') return hooks.execute({ parsed, asset, env, plan })
  return executeLive(parsed, asset, env)
}

async function main() {
  try {
    const { doc, report } = await runT7Live()
    console.log(formatLiveSuccessStdout(doc, report))
    process.exitCode = 0
  } catch (error) {
    const code = error instanceof LiveBlock ? error.code : 'LIVE_FAILED'
    const category = error instanceof LiveBlock ? error.category : 'runner'
    console.error(formatBlockedOutput(code, category))
    process.exitCode = 1
  }
}

async function executeLive(parsed, asset, env) {
  const hostEnv = { ...env }
  let dshBin
  try {
    dshBin = await ensureOfficialDsh(parsed.dshVersion)
    assertExactDshVersion(runDsh(dshBin, ['--version'], hostEnv), parsed.dshVersion)
  } catch (error) {
    if (error instanceof LiveBlock) throw error
    throw new LiveBlock('DSH_VERSION', 'environment')
  }
  const home = isolatedHome(parsed.dshVersion, 't7-live')
  hostEnv.DSH_HOME = home
  try {
    execFileSync(dshBin, ['plugin', '--profile', 'web', 'add', parsed.clarifyTgz], {
      env: hostEnv,
      encoding: 'utf8',
      timeout: 120_000,
    })
    execFileSync(dshBin, ['plugin', '--profile', 'web', 'add', parsed.auxiliaryTgz], {
      env: hostEnv,
      encoding: 'utf8',
      timeout: 120_000,
    })
  } catch {
    throw new LiveBlock('HOST_BOOT', 'environment')
  }
  const dumpText = runDsh(dshBin, ['--profile', 'web', '--dump-config'], hostEnv)
  const seekTty = observeSeekTtyInstalled(dumpText)
  if (seekTty.proven !== true || seekTty.installed !== false) {
    throw new LiveBlock('SEEKTTY', 'environment')
  }
  assertLiveRouteCredential(dumpText, env)
  const child = spawnDsh(dshBin, ['--profile', 'web', '--port', '0', '--no-open'], hostEnv)
  let bootOutput = ''
  child.stdout.on('data', (chunk) => { bootOutput += String(chunk) })
  child.stderr.on('data', (chunk) => { bootOutput += String(chunk) })
  try {
    const { origin } = await waitForPrintedOrigin(child, () => bootOutput, 90_000)
    return await runAgainstOrigin(origin, home, asset, parsed)
  } catch (error) {
    if (error instanceof LiveBlock) throw error
    throw new LiveBlock('HOST_BOOT', 'environment')
  } finally {
    await stopChild(child)
  }
}

async function runAgainstOrigin(origin, home, asset, parsed) {
  const html = await fetchText(new URL('/clarify', origin).href)
  const diy = inspectDiySurface(html)
  if (diy.present !== true || diy.createsSession !== false || !T7_DIY_METHODS.every((name) => diy.methods?.[name] === true)) {
    throw new LiveBlock('DIY_SURFACE', 'environment')
  }
  const seeded = await seedOfficialPublicSession(postApi, origin, {
    workspacePath: createIsolatedWorkspacePath(home),
    home,
  })
  if (!seeded.sessionId) throw new LiveBlock('SESSION_SEED', 'environment')
  const preRaw = await takePublicSnapshot(postApi, origin, seeded.sessionId)
  const preCallSnapshot = snapshotImmediateBeforeFirstClarifyRpc(preRaw)
  if (!allObserved(preRaw)) throw new LiveBlock('SNAPSHOT', 'snapshot')

  const network = { events: [], sendGate: createOfficialSendGate(), blocked: null }
  const machine = await withChromium(async (browser) => {
    const context = await browser.newContext()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    const diyPage = await context.newPage()
    attachNetwork(diyPage, network)
    await diyPage.goto(new URL('/clarify', origin).href, { waitUntil: 'domcontentloaded' })
    const walked = await clickDiyJourney(diyPage, network, seeded.sessionId)
    if (walked.status === 'blocked') return walked
    if (walked.status !== 'complete') throw new LiveBlock('DIY_JOURNEY', 'sequence')

    const postRaw = await takePublicSnapshot(postApi, origin, seeded.sessionId)
    if (!allObserved(postRaw) || !windowUnchanged(preCallSnapshot, postRaw)) {
      throw new LiveBlock('CLARIFY_WINDOW_CHANGED', 'snapshot')
    }
    const officialPage = await context.newPage()
    attachNetwork(officialPage, network)
    await officialPage.goto(new URL('/', origin).href, { waitUntil: 'domcontentloaded' })
    const official = await pasteThenOfficialSend(officialPage, network)
    const postSendRaw = await waitForSendTurns(origin, seeded.sessionId, postRaw)
    return {
      walked,
      postCallSnapshot: { ...postRaw, beforeOfficialSend: true },
      postSendSnapshot: { ...postSendRaw, afterOfficialSend: true },
      pasteProof: official.pasteProof,
      sendGate: official.sendGate,
    }
  })

  if (machine.walked) {
    return finishDocument({
      parsed,
      asset,
      diy,
      seeded,
      preCallSnapshot,
      machine: machine.walked,
      postCallSnapshot: machine.postCallSnapshot,
      postSendSnapshot: machine.postSendSnapshot,
      pasteProof: machine.pasteProof,
      sendGate: machine.sendGate,
    })
  }
  throw new LiveBlock(machine.stopReason || 'DIY_JOURNEY', machine.stopCategory || 'preflight')
}

function finishDocument({
  parsed,
  asset,
  diy,
  seeded,
  preCallSnapshot,
  machine,
  postCallSnapshot,
  postSendSnapshot,
  pasteProof,
  sendGate,
}) {
  const receipts = liveJourneyReceipts({ pasteProof, sendGate })
  if (receipts.pasteBlock) {
    throw new LiveBlock(receipts.pasteBlock.code, receipts.pasteBlock.category)
  }
  if (receipts.sendBlock) {
    throw new LiveBlock(receipts.sendBlock.code, receipts.sendBlock.category)
  }
  const doc = buildT7Document({
    hostVersion: parsed.dshVersion,
    clarifyVersion: '0.2.2',
    gate: 'T7',
    noKey: false,
    mock: false,
    seekTtyInstalled: false,
    seekTtyProven: true,
    recommendedJointBaseline: false,
    webOnlyComplete: true,
    draftManuallyPasted: receipts.draftManuallyPasted,
    userSent: receipts.userSent,
    pluginAutoSent: receipts.pluginAutoSent,
    asset,
    session: seeded.label ?? labelOfficialPublicSession({ createdByThisScript: true }),
    preCallSnapshot,
    postCallSnapshot,
    postSendSnapshot,
    diy,
    diyJourney: {
      surface: 'host-diy',
      ok: T7_DIY_METHODS.every((name) => machine.methods[name] === 'succeeded'),
      methods: machine.methods,
    },
    manualDraftTransfer: receipts.manualDraftTransfer,
    officialComposerSend: receipts.officialComposerSend,
    cancelRecovery: machine.cancelRecovery,
    pollutionProbes: honestPollutionProbes(),
  })
  const checked = validateT7Document(doc)
  if (!checked.ok || isFullT7(doc) !== true) {
    throw new LiveBlock('FULL_T7_FALSE', 'predicate')
  }
  return { doc, report: formatT7Report(doc) }
}

async function withChromium(fn) {
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    throw new LiveBlock('PLAYWRIGHT_MISSING', 'browser')
  }
  let browser
  try {
    browser = await chromium.launch()
  } catch {
    throw new LiveBlock('CHROMIUM_MISSING', 'browser')
  }
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

async function clickDiyJourney(page, network, sessionId) {
  let machine = createDiyJourneyMachine()
  await focusAndType(page, '#sessionId', sessionId)
  await focusAndType(page, '#seed', ambiguousLiveSeed())
  const steps = [
    (current) => clickAndCollect(page, network, current, '#start', 'start'),
    (current) => clickAndCollect(page, network, current, '#cancel', 'cancel'),
    (current) => clickAndCollect(page, network, current, '#start', 'start'),
    async (current) => {
      await prepareDiyAnswer(page)
      return clickAndCollect(page, network, current, '#answer', 'answer')
    },
    async (current) => {
      await focusAndType(page, '#feedback', 'ok')
      return clickAndCollect(page, network, current, '#refine', 'refine')
    },
    (current) => clickAndCollect(page, network, current, '#accept', 'accept'),
    (current) => clickAndCollect(page, network, current, '#fetch', 'fetchDraft'),
    async (current) => {
      await page.locator('#copy').click({ timeout: 15_000 })
      return applyDiyJourneyEvent(current, { method: 'copy', ok: true })
    },
  ]
  for (const step of steps) {
    if (!canAdvanceDiyJourney(machine)) return machine
    machine = await step(machine)
  }
  return machine
}

async function prepareDiyAnswer(page) {
  const surface = await page.evaluate(() => ({
    optionCount: document.querySelectorAll('input[name=option]').length,
    allowCustom: Boolean(document.getElementById('custom')),
  }))
  const action = selectDiyAnswerAction(surface)
  if (action.ok !== true) throw new LiveBlock(action.code, action.category)
  if (action.action === 'first-option') {
    await page.locator('input[name=option]').first().click({ timeout: 15_000 })
    return
  }
  await focusAndType(page, '#custom', 'y')
}

async function clickAndCollect(page, network, machine, selector, method) {
  if (!canAdvanceDiyJourney(machine)) return machine
  if (network.blocked) {
    return applyDiyJourneyEvent(machine, { kind: officialSendMethod() })
  }
  const from = network.events.length
  await page.locator(selector).click({ timeout: 15_000 })
  const receipt = await waitReceipt(network, method, from, 60_000)
  return applyDiyJourneyEvent(machine, receipt)
}

async function waitReceipt(network, method, from, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (network.blocked) throw new LiveBlock(network.blocked.code, network.blocked.category)
    const hit = network.events.slice(from).find((event) => event.method === method)
    if (hit) return hit
    await delay(100)
  }
  throw new LiveBlock('METHOD_TIMEOUT', 'rpc')
}

async function pasteThenOfficialSend(page, network) {
  const nodes = await page.evaluate(() => {
    const out = []
    const list = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], button, [type="submit"]')
    list.forEach((el, index) => {
      out.push({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        name: el.getAttribute('name') || '',
        title: el.getAttribute('title') || '',
        type: el.getAttribute('type') || '',
        text: String(el.textContent || '').slice(0, 48),
        contenteditable: el.getAttribute('contenteditable') === 'true',
      })
    })
    return out
  })
  const selected = selectOfficialComposer(nodes)
  if (selected.ok !== true) throw new LiveBlock(selected.code, selected.category)
  const handles = page.locator('textarea, [contenteditable="true"], [role="textbox"], button, [type="submit"]')
  const composer = handles.nth(selected.composer.index)
  const send = handles.nth(selected.send.index)
  await composer.click({ timeout: 10_000 })
  await page.keyboard.press(officialPasteShortcut())
  const pasteProof = await composer.evaluate(async (el) => {
    const clipboardText = await navigator.clipboard.readText()
    const composerText = typeof el.value === 'string' ? el.value : String(el.innerText || '')
    const nonEmpty = clipboardText.length > 0 && composerText.length > 0
    const exactMatch = clipboardText.length > 0 && clipboardText === composerText
    return { nonEmpty, exactMatch }
  })
  requireManualPasteProof(pasteProof)
  network.sendGate = armOfficialSendGate(network.sendGate)
  await send.click({ timeout: 10_000 })
  await waitOfficialSendProof(network)
  return { pasteProof, sendGate: network.sendGate }
}

async function waitOfficialSendProof(network, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (network.sendGate.premature === true) {
      throw new LiveBlock('SESSION_PROMPT', 'forbidden')
    }
    if (network.sendGate.officialSendCount > 1) {
      throw new LiveBlock('OFFICIAL_SEND_COUNT', 'operator')
    }
    const receipts = deriveOfficialSendReceipts(network.sendGate)
    if (receipts.ok === true) return receipts
    await delay(50)
  }
  throw new LiveBlock('OFFICIAL_SEND_MISSING', 'operator')
}

async function waitForSendTurns(origin, sessionId, postCall) {
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    last = await takePublicSnapshot(postApi, origin, sessionId)
    if (comparisonState(postCall.sessionCount, last.sessionCount, 'sessionCount') === 'changed') {
      throw new LiveBlock('SESSION_SWITCHED', 'snapshot')
    }
    if (last.blankTurns?.blank === false && last.blankTurns?.hasTurns === true) return last
    await delay(1000)
  }
  throw new LiveBlock('SEND_NO_TURNS', 'snapshot')
}

function attachNetwork(page, network) {
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    let pathname = ''
    try {
      pathname = new URL(request.url()).pathname
    } catch {
      return
    }
    if (classifyLiveEndpoint(pathname).kind === 'forbidden') {
      network.sendGate = noteOfficialSendAttempt(network.sendGate)
      if (network.sendGate.premature === true) {
        network.blocked = { code: 'SESSION_PROMPT', category: 'forbidden' }
      }
    }
  })
  page.on('response', async (response) => {
    if (response.request().method() !== 'POST') return
    let pathname = ''
    try {
      pathname = new URL(response.url()).pathname
    } catch {
      return
    }
    if (classifyLiveEndpoint(pathname).kind !== 'clarify') return
    let json
    try {
      json = await response.json()
    } catch {
      json = undefined
    }
    const receipt = extractClarifyReceipt(pathname, json)
    if (receipt) network.events.push(receipt)
  })
}

async function focusAndType(page, selector, text) {
  await page.locator(selector).click({ timeout: 15_000 })
  await page.keyboard.type(text, { delay: 0 })
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  return response.text()
}

function allObserved(snapshot) {
  return T7_REQUIRED_COMPARISON_KEYS.every((name) => (
    snapshot?.[name]?.available === true && snapshot?.[name]?.status === 'observed'
  ))
}

function windowUnchanged(before, after) {
  return T7_REQUIRED_COMPARISON_KEYS.every((name) => comparisonState(before[name], after[name], name) === 'unchanged')
}

function redactLiveSeed(text) {
  const seed = ambiguousLiveSeed()
  return seed ? String(text).split(seed).join('') : String(text)
}

function redactLiveSeedDeep(value) {
  if (typeof value === 'string') return redactLiveSeed(value)
  if (Array.isArray(value)) return value.map(redactLiveSeedDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = redactLiveSeedDeep(nested)
    return out
  }
  return value
}

function stripLiveOnlyKeys(value) {
  if (Array.isArray(value)) return value.map(stripLiveOnlyKeys)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'question' || key === 'origin' || /api[_-]?key/i.test(key)) continue
      out[key] = stripLiveOnlyKeys(nested)
    }
    return out
  }
  return value
}

const OFFICIAL_ROUTE_ENV = Object.freeze({
  'deepseek-official': 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
})

function providerKeyNames() {
  return PROVIDER_KEY_VENDORS.map((vendor) => `${vendor}_API_KEY`)
}

function readAgentDefaultModelProvider(dumpText) {
  const items = yamlLikeListItems(dumpText)
  const matches = []
  for (const item of items) {
    const entries = yamlLikeItemEntries(item)
    const ids = entries.filter((entry) => entry.key === 'id').map((entry) => yamlLikeScalar(entry.value))
    if (ids.length === 1 && ids[0] === 'agent-default-model') matches.push(entries)
  }
  if (matches.length !== 1) return undefined
  const configs = matches[0].filter((entry) => entry.key === 'config')
  if (configs.length !== 1) return undefined
  const providers = yamlLikeMappingValues(configs[0], 'provider')
  if (providers.length !== 1 || providers[0] === '') return undefined
  return providers[0]
}

function yamlLikeListItems(dumpText) {
  const lines = normalizeDumpLines(dumpText)
  const items = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const start = line.match(/^([ \t]*)-\s+(.*)$/)
    if (!start) {
      index += 1
      continue
    }
    const dashIndent = start[1].length
    const body = [start[2]]
    index += 1
    while (index < lines.length) {
      const next = lines[index]
      if (next.trim() === '') {
        body.push('')
        index += 1
        continue
      }
      if (lineIndent(next) <= dashIndent) break
      body.push(next)
      index += 1
    }
    items.push(body)
  }
  return items
}

function yamlLikeItemEntries(body) {
  const entries = []
  const first = yamlLikeKeyValue(String(body[0] ?? '').trim())
  if (first) entries.push({ key: first.key, value: first.value, nested: [] })
  let childIndent
  for (const line of body.slice(1)) {
    if (line.trim() === '' || isYamlLikeComment(line)) continue
    childIndent = lineIndent(line)
    break
  }
  if (childIndent === undefined) return entries
  let current
  for (const line of body.slice(1)) {
    if (line.trim() === '' || isYamlLikeComment(line)) {
      if (current) current.nested.push(line)
      continue
    }
    const indent = lineIndent(line)
    if (indent === childIndent) {
      const pair = yamlLikeKeyValue(line.trim())
      current = pair ? { key: pair.key, value: pair.value, nested: [] } : undefined
      if (current) entries.push(current)
      continue
    }
    if (indent > childIndent && current) current.nested.push(line)
    else current = undefined
  }
  return entries
}

function yamlLikeMappingValues(entry, key) {
  if (yamlLikeScalar(entry?.value) !== '') return []
  let childIndent
  for (const line of entry.nested ?? []) {
    if (line.trim() === '' || isYamlLikeComment(line)) continue
    childIndent = lineIndent(line)
    break
  }
  if (childIndent === undefined) return []
  const values = []
  for (const line of entry.nested) {
    if (line.trim() === '' || isYamlLikeComment(line) || lineIndent(line) !== childIndent) continue
    const pair = yamlLikeKeyValue(line.trim())
    if (pair?.key === key) values.push(yamlLikeScalar(pair.value))
  }
  return values
}

function yamlLikeKeyValue(content) {
  const match = String(content ?? '').match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
  if (!match) return undefined
  return { key: match[1], value: match[2] }
}

function yamlLikeScalar(raw) {
  let value = String(raw ?? '').trim()
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1)
  }
  return value.trim()
}

function normalizeDumpLines(dumpText) {
  return String(dumpText ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function lineIndent(line) {
  return (/^[ \t]*/.exec(line) ?? [''])[0].length
}

function isYamlLikeComment(line) {
  return /^\s*#/.test(line)
}

function classifyArgvError(error) {
  const message = error instanceof Error ? error.message : ''
  if (/0\.1\.1-rc\.2|dsh --version|exact @deepseek-ai\/dsh/i.test(message)) return 'DSH_VERSION'
  if (/tgz|SHA256|clarify-release|auxiliary-release|known/i.test(message)) return 'ASSETS'
  return 'ARGV'
}

function controlText(node) {
  return [node?.ariaLabel, node?.placeholder, node?.name, node?.title, node?.text].filter(Boolean).join(' ')
}

function isComposerField(node) {
  return node?.role === 'textbox' || node?.tag === 'textarea' || node?.contenteditable === true
}

function isSendControl(node) {
  return node?.role === 'button' || node?.tag === 'button' || node?.type === 'submit'
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (isT7LiveMain(import.meta.url, process.argv[1])) {
  void main()
}

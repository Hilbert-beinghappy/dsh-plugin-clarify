import { T7_FORBIDDEN_KEYS, sanitizeT7 } from './sanitize.mjs'
import { PINNED_DSH_VERSION } from './versions.mjs'

export const T7_PROTOCOL = 't7/1'
export const T7_COMPARISON_STATES = new Set(['unchanged', 'changed', 'unavailable'])
export const T7_USAGE_BANDS = new Set(['zero', 'nonzero', 'unavailable'])
export const T7_COUNT_BANDS = new Set(['zero', 'one', 'many', 'unavailable'])
export const T7_REQUIRED_COMPARISON_KEYS = ['sessionCount', 'blankTurns', 'officialUsage']
export const T7_CLARIFY_RELEASE = '0.2.2'
export const T7_AUXILIARY_RELEASE = '0.1.1'
export const T7_CLARIFY_TGZ_NAME = 'dsh-plugin-clarify-0.2.2.tgz'
export const T7_AUXILIARY_TGZ_NAME = 'dsh-plugin-auxiliary-runtime-0.1.1.tgz'
export const T7_DIY_METHODS = ['start', 'answer', 'accept', 'refine', 'cancel', 'fetchDraft']

export function usageBand(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unavailable'
  return value === 0 ? 'zero' : 'nonzero'
}

export function countBand(value) {
  if (!Number.isInteger(value) || value < 0) return 'unavailable'
  if (value === 0) return 'zero'
  if (value === 1) return 'one'
  return 'many'
}

export function unavailableRead(reason) {
  return {
    available: false,
    status: 'unavailable',
    reason,
  }
}

export function comparePublicObservation(before, after, kind) {
  if (!isObservedPublic(before, kind) || !isObservedPublic(after, kind)) {
    return { available: false, status: 'unavailable' }
  }
  return {
    available: true,
    status: 'observed',
    unchanged: JSON.stringify(publicCompareFields(before)) === JSON.stringify(publicCompareFields(after)),
  }
}

export function comparisonState(before, after, kind) {
  const compared = comparePublicObservation(before, after, kind)
  if (!compared.available) return 'unavailable'
  return compared.unchanged ? 'unchanged' : 'changed'
}

export function classifyAssetProvenance(input = {}) {
  if (input.mode === 'from-pack') {
    return { mode: 'from-pack', checksumVerified: false, userValue: false }
  }
  const checksumVerified = input.mode === 'from-release' && input.checksumVerified === true
  return {
    mode: input.mode,
    checksumVerified,
    userValue: checksumVerified,
  }
}

export function isUserValueEvidence(asset) {
  return asset?.mode === 'from-release' && asset?.checksumVerified === true && asset?.userValue === true
}

export function classifyT7(evidence) {
  return {
    gate: evidence?.gate,
    fullT7: isFullT7(evidence),
    noKey: evidence?.noKey === true,
    mock: evidence?.mock === true,
  }
}

export function isFullT7(evidence) {
  if (!validateT7Structure(evidence).ok) return false
  return fullT7Predicate(evidence)
}

export function isG0Pass(evidence) {
  if (!validateT7Structure(evidence).ok) return false
  return g0Predicate(evidence)
}

export function sanitizeT7Document(value) {
  return sanitizeT7(value)
}

export function buildT7Document(observation = {}) {
  const asset = {
    ...classifyAssetProvenance(observation.asset),
    ...pickDefined(observation.asset, ['clarifyRelease', 'auxiliaryRelease']),
  }
  const preCallSnapshot = observation.preCallSnapshot ?? {}
  const postCallSnapshot = observation.postCallSnapshot ?? {}
  const comparisons = {
    sessionCount: comparisonState(preCallSnapshot.sessionCount, postCallSnapshot.sessionCount, 'sessionCount'),
    blankTurns: comparisonState(preCallSnapshot.blankTurns, postCallSnapshot.blankTurns, 'blankTurns'),
    officialUsage: comparisonState(preCallSnapshot.officialUsage, postCallSnapshot.officialUsage, 'officialUsage'),
  }
  const doc = sanitizeT7Document({
    protocol: T7_PROTOCOL,
    hostVersion: observation.hostVersion,
    clarifyVersion: observation.clarifyVersion,
    gate: observation.gate,
    noKey: observation.noKey === true,
    mock: observation.mock === true,
    seekTtyProven: observation.seekTtyProven === true,
    ...(observation.seekTtyProven === true
      ? { seekTtyInstalled: observation.seekTtyInstalled === true }
      : {}),
    recommendedJointBaseline: observation.recommendedJointBaseline === true,
    webOnlyComplete: observation.webOnlyComplete === true,
    draftManuallyPasted: observation.draftManuallyPasted === true,
    userSent: observation.userSent === true,
    pluginAutoSent: observation.pluginAutoSent === true,
    asset,
    session: observation.session,
    preCallSnapshot,
    start: pickDefined(observation.start, ['errorCode', 'providerFailureCode', 'missingCredential']),
    postCallSnapshot,
    comparisons,
    diy: observation.diy && typeof observation.diy === 'object'
      ? {
        ...pickDefined(observation.diy, ['present', 'createsSession']),
        ...(observation.diy.methods && typeof observation.diy.methods === 'object'
          ? { methods: pickDefined(observation.diy.methods, T7_DIY_METHODS) }
          : {}),
      }
      : observation.diy,
    diyJourney: observation.diyJourney,
    manualDraftTransfer: observation.manualDraftTransfer,
    officialComposerSend: observation.officialComposerSend,
    cancelRecovery: observation.cancelRecovery,
    pollutionProbes: observation.pollutionProbes,
    publicReads: observation.publicReads,
    note: 'no-key/mocks never equal full T7',
  })
  doc.fullT7 = isFullT7(doc)
  doc.g0Verdict = isG0Pass(doc) ? '通过' : '阻塞'
  return doc
}

export function validateT7Structure(doc) {
  const errors = []
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['document missing'] }
  if (doc.protocol !== T7_PROTOCOL) errors.push('protocol must be t7/1')
  if (doc.preCallSnapshot?.immediate !== true || doc.preCallSnapshot?.beforeFirstClarifyRpc !== true) {
    errors.push('preCallSnapshot must be immediate and beforeFirstClarifyRpc')
  }
  if (doc.session?.source !== 'official-public-remote') errors.push('session.source must be official-public-remote')
  if (doc.session?.productionPluginCreated !== false) errors.push('productionPluginCreated must be false')
  if (typeof doc.session?.createdByThisScript !== 'boolean') errors.push('createdByThisScript must be boolean')
  validateSeekTtyClaims(doc, errors)
  validateComparisonMap(doc.comparisons, errors)
  for (const name of T7_REQUIRED_COMPARISON_KEYS) {
    validatePublicRead(`preCallSnapshot.${name}`, doc.preCallSnapshot?.[name], name, errors)
    validatePublicRead(`postCallSnapshot.${name}`, doc.postCallSnapshot?.[name], name, errors)
    assertComparisonBacked(doc, name, errors)
  }
  collectForbidden(doc, errors)
  return { ok: errors.length === 0, errors }
}

export function validateT7Document(doc) {
  const structural = validateT7Structure(doc)
  const errors = [...structural.errors]
  if (structural.ok) {
    if (doc.fullT7 !== fullT7Predicate(doc)) errors.push('fullT7 claim disagrees with derived predicate')
    const derivedG0 = g0Predicate(doc) ? '通过' : '阻塞'
    if (doc.g0Verdict !== derivedG0) errors.push('g0Verdict claim disagrees with derived G0')
  }
  return { ok: errors.length === 0, errors }
}

export function evaluateTrackedT7(doc, reportText) {
  const errors = []
  const checked = validateT7Document(doc)
  if (!checked.ok) errors.push(...checked.errors)
  const report = String(reportText ?? '')
  if (!report.includes(T7_PROTOCOL) && !report.includes('t7/1')) errors.push('report must declare t7/1')
  const g0 = isG0Pass(doc)
  const full = isFullT7(doc)
  if (g0 && !report.includes('通过')) errors.push('G0 pass report must say 通过')
  if (!g0 && !report.includes('阻塞')) errors.push('blocked G0 report must say 阻塞')
  if (doc.seekTtyProven !== true && (report.includes('| SeekTTY | 未安装') || report.includes('| SeekTTY | 已安装'))) {
    errors.push('unproven SeekTTY report must not state 未安装/已安装')
  }
  if (doc.seekTtyProven !== true && !report.includes('未知/未证明')) {
    errors.push('unproven SeekTTY report must say 未知/未证明')
  }
  if (full) {
    if (!report.includes('| 完整 T7 | 是')) errors.push('full T7 report must classify 完整 T7 as 是')
    if (report.includes('剩余 Codex live T7')) errors.push('full T7 report must not say 剩余 Codex live T7')
  } else if (!report.includes('不是完整 T7') && !report.includes('| 完整 T7 | 否')) {
    errors.push('incomplete T7 report must say 不是完整 T7')
  }
  return {
    ok: errors.length === 0,
    errors,
    fullT7: full,
    g0,
    g0Label: g0 ? '通过' : '阻塞',
  }
}

export function requireFromReleaseAssets(parsed) {
  if (parsed?.mode !== 'from-release') return parsed
  const clarifyPair = Boolean(parsed.clarifyTgz && parsed.clarifySums)
  const auxiliaryPair = Boolean(parsed.auxiliaryTgz && parsed.auxiliarySums)
  if (!clarifyPair) {
    throw new Error('阻塞：--from-release requires local published Clarify tgz and SHA256SUMS')
  }
  if (!auxiliaryPair) {
    throw new Error('阻塞：--from-release requires local published Auxiliary tgz and SHA256SUMS')
  }
  if (parsed.clarifyRelease !== T7_CLARIFY_RELEASE || parsed.auxiliaryRelease !== T7_AUXILIARY_RELEASE) {
    throw new Error('阻塞：--from-release requires known --clarify-release 0.2.2 and --auxiliary-release 0.1.1')
  }
  return parsed
}

export function wrapAssetReadError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0]
  return new Error(firstLine.startsWith('阻塞：') ? firstLine : '阻塞：unable to read local published tgz or SHA256SUMS')
}

export function parseT7LabArgs(argv) {
  const args = Array.isArray(argv) ? argv : []
  const flags = ['--validate', '--from-pack', '--from-release'].filter((flag) => args.includes(flag))
  if (flags.length !== 1) {
    throw new Error('t7-lab requires exactly one of --validate, --from-pack, or --from-release')
  }
  const mode = flags[0].slice(2)
  const dshVersion = optionValue(args, '--dsh-version') ?? PINNED_DSH_VERSION
  if (dshVersion !== PINNED_DSH_VERSION) {
    throw new Error(`T7 accepts only exact @deepseek-ai/dsh@${PINNED_DSH_VERSION}`)
  }
  return {
    mode,
    userValue: false,
    requireLocalAssets: mode === 'from-release' || args.includes('--require-local-assets'),
    dshVersion,
    clarifyTgz: optionValue(args, '--clarify-tgz'),
    clarifySums: optionValue(args, '--clarify-sums'),
    auxiliaryTgz: optionValue(args, '--auxiliary-tgz'),
    auxiliarySums: optionValue(args, '--auxiliary-sums'),
    clarifyRelease: optionValue(args, '--clarify-release'),
    auxiliaryRelease: optionValue(args, '--auxiliary-release'),
    write: args.includes('--write'),
  }
}

export function formatT7Report(doc) {
  const checked = validateT7Document(doc)
  const complete = doc.fullT7 === true
  const intro = complete
    ? `> 协议 \`${T7_PROTOCOL}\`。只记录布尔值与粗带。
> 本文件记录一次完整 T7。无 key / mock / \`--from-pack\` 仍不等于完整 T7。
> 用户价值证据必须来自校验和核验的已发布资产。`
    : `> 协议 \`${T7_PROTOCOL}\`。只记录布尔值与粗带。
> G0 无 key 观察**不是完整 T7**。无 key / mock 不等于完整 T7。
> 用户价值证据必须来自校验和核验的已发布资产。\`--from-pack\` 与 mock 不得写成完整 T7。`
  const remaining = complete
    ? ''
    : `
## 剩余 Codex live T7

完整 T7 仍要求校验和核验的已发布 Clarify+Auxiliary 资产对、真实 provider、无 SeekTTY，以及证据支撑的六方法 DIY 旅程、手动粘贴 draft、官方 composer 常规发送、cancel/recovery 观察和公开污染探针。无 key / mock / 七个布尔声明不等于完整 T7。
`
  return `# T7 证据（${doc.hostVersion ?? 'unknown'}）

${intro}

## 总结论

| 项 | 结论 |
| --- | --- |
| 闸门 | ${doc.gate ?? '未记录'} |
| G0 | ${isG0Pass(doc) ? '通过' : '阻塞'} |
| 完整 T7 | ${complete ? '是' : '否'} |
| 无 key | ${doc.noKey === true} |
| 资产 | ${doc.asset?.mode ?? 'n/a'} / 校验和核验=${doc.asset?.checksumVerified === true} / 用户价值=${doc.asset?.userValue === true} |
| 推荐联合基线 | ${doc.recommendedJointBaseline === true ? '是' : '否'} |
| SeekTTY | ${formatSeekTtyLabel(doc)} |
| schema | ${checked.ok ? '通过' : checked.errors.join('；')} |

## G0

- Start：${formatStartLine(doc.start)}
- 调用前快照：立即、第一次 Clarify RPC 之前（\`immediate=${doc.preCallSnapshot?.immediate === true}\`，\`beforeFirstClarifyRpc=${doc.preCallSnapshot?.beforeFirstClarifyRpc === true}\`）
- session 计数：\`${doc.comparisons?.sessionCount ?? 'unavailable'}\`
- blank / turns：\`${doc.comparisons?.blankTurns ?? 'unavailable'}\`
- 官方用量：\`${doc.comparisons?.officialUsage ?? 'unavailable'}\`
- Session 标签：\`source=${doc.session?.source}\`，\`productionPluginCreated=${doc.session?.productionPluginCreated === true}\`，\`createdByThisScript=${doc.session?.createdByThisScript === true}\`
- 插件 / DIY 不创建 Session：\`${doc.diy?.createsSession === false}\`
${remaining}`
}

function fullT7Predicate(evidence) {
  return evidence?.gate === 'T7'
    && evidence?.webOnlyComplete === true
    && evidence?.draftManuallyPasted === true
    && evidence?.userSent === true
    && evidence?.pluginAutoSent === false
    && isUserValueEvidence(evidence?.asset)
    && evidence?.noKey !== true
    && evidence?.mock !== true
    && evidence?.seekTtyInstalled === false
    && evidence?.recommendedJointBaseline !== true
    && observedSnapshotPair(evidence)
    && sixMethodDiyJourneySucceeded(evidence)
    && manualDraftTransferObserved(evidence)
    && officialComposerSendObserved(evidence)
    && cancelRecoveryObserved(evidence)
    && publicPollutionProbesObserved(evidence)
}

function g0Predicate(evidence) {
  return evidence?.protocol === T7_PROTOCOL
    && evidence?.gate === 'G0'
    && evidence?.fullT7 === false
    && evidence?.noKey === true
    && evidence?.mock === false
    && evidence?.seekTtyInstalled === false
    && evidence?.seekTtyProven === true
    && evidence?.start?.errorCode === 'INFERENCE_UNAVAILABLE'
    && isStableProviderFailureCode(evidence?.start?.providerFailureCode)
    && evidence?.preCallSnapshot?.immediate === true
    && evidence?.preCallSnapshot?.beforeFirstClarifyRpc === true
    && observedUnchanged(evidence, 'sessionCount')
    && observedUnchanged(evidence, 'blankTurns')
    && observedUnchanged(evidence, 'officialUsage')
    && evidence?.session?.source === 'official-public-remote'
    && evidence?.session?.productionPluginCreated === false
    && evidence?.session?.createdByThisScript === true
    && isUserValueEvidence(evidence?.asset)
    && evidence?.diy?.present === true
    && evidence?.diy?.createsSession === false
    && diySixMethodsPresent(evidence)
}

export function isStableProviderFailureCode(code) {
  return typeof code === 'string' && code !== 'UNKNOWN' && /^[A-Z][A-Z0-9_]{1,32}$/.test(code)
}

function observedUnchanged(evidence, name) {
  const pre = evidence?.preCallSnapshot?.[name]
  const post = evidence?.postCallSnapshot?.[name]
  return isObservedPublic(pre, name)
    && isObservedPublic(post, name)
    && comparisonState(pre, post, name) === 'unchanged'
    && evidence?.comparisons?.[name] === 'unchanged'
}

function observedSnapshotPair(evidence) {
  return T7_REQUIRED_COMPARISON_KEYS
    .every((name) => isObservedPublic(evidence?.preCallSnapshot?.[name], name) && isObservedPublic(evidence?.postCallSnapshot?.[name], name))
}

function assertComparisonBacked(doc, name, errors) {
  const claimed = doc.comparisons?.[name]
  const pre = doc.preCallSnapshot?.[name]
  const post = doc.postCallSnapshot?.[name]
  if (claimed !== 'unchanged' && claimed !== 'changed') return
  if (!isObservedPublic(pre, name) || !isObservedPublic(post, name)) {
    errors.push(`comparisons.${name}=${claimed} but pre/post are unavailable`)
    return
  }
  const derived = comparisonState(pre, post, name)
  if (derived !== claimed) {
    errors.push(`comparisons.${name}=${claimed} inconsistent with pre/post (${derived})`)
  }
}

function validateComparisonMap(comparisons, errors) {
  if (!comparisons || typeof comparisons !== 'object' || Array.isArray(comparisons)) {
    errors.push('comparisons must contain exactly sessionCount/blankTurns/officialUsage')
    return
  }
  const keys = Object.keys(comparisons)
  const extra = keys.filter((key) => !T7_REQUIRED_COMPARISON_KEYS.includes(key))
  const missing = T7_REQUIRED_COMPARISON_KEYS.filter((key) => !Object.hasOwn(comparisons, key))
  if (extra.length > 0 || missing.length > 0) {
    errors.push('comparisons must contain exactly sessionCount/blankTurns/officialUsage')
  }
  for (const name of T7_REQUIRED_COMPARISON_KEYS) {
    if (comparisons[name] !== undefined && !T7_COMPARISON_STATES.has(comparisons[name])) {
      errors.push(`comparisons.${name} must be a coarse state`)
    }
  }
}

function validatePublicRead(path, value, kind, errors) {
  if (!value || typeof value !== 'object') {
    errors.push(`${path} missing required payload`)
    return
  }
  if (value.status === 'unavailable') {
    if (value.available !== false) errors.push(`${path} unavailable form requires available=false`)
    if ('band' in value || 'blank' in value || 'hasTurns' in value) {
      errors.push(`${path} unavailable form must not carry observed fields`)
    }
    return
  }
  if (value.status === 'observed') {
    if (value.available !== true) errors.push(`${path} observed form requires available=true`)
    if (kind === 'sessionCount' && !isObservedCountBand(value.band)) {
      errors.push(`${path} band must be a count band`)
    }
    if (kind === 'officialUsage' && !isObservedUsageBand(value.band)) {
      errors.push(`${path} band must be a usage band`)
    }
    if (kind === 'blankTurns' && (typeof value.blank !== 'boolean' || typeof value.hasTurns !== 'boolean')) {
      errors.push(`${path} must include blank/hasTurns booleans`)
    }
    return
  }
  errors.push(`${path} must be observed or unavailable`)
}

function validateSeekTtyClaims(doc, errors) {
  const proven = doc.seekTtyProven === true
  if (!proven && typeof doc.seekTtyInstalled === 'boolean') {
    errors.push('seekTtyInstalled cannot be a definite boolean unless seekTtyProven=true')
  }
  if (proven && typeof doc.seekTtyInstalled !== 'boolean') {
    errors.push('seekTtyInstalled must be boolean when seekTtyProven=true')
  }
}

function formatSeekTtyLabel(doc) {
  if (doc.seekTtyProven !== true) return '未知/未证明'
  return doc.seekTtyInstalled === true ? '已安装' : '未安装'
}

function formatStartLine(start) {
  const errorCode = start?.errorCode ?? 'n/a'
  const failure = start?.providerFailureCode
  if (isStableProviderFailureCode(failure)) {
    return `\`${errorCode}\` + \`providerFailureCode=${failure}\``
  }
  return `\`${errorCode}\``
}

function diySixMethodsPresent(evidence) {
  return T7_DIY_METHODS.every((name) => evidence?.diy?.methods?.[name] === true)
}

function sixMethodDiyJourneySucceeded(evidence) {
  const methods = evidence?.diyJourney?.methods
  if (evidence?.diyJourney?.surface !== 'host-diy' || evidence?.diyJourney?.ok !== true) return false
  return ['start', 'answer', 'accept', 'refine', 'cancel', 'fetchDraft']
    .every((name) => methods?.[name] === 'succeeded')
}

function manualDraftTransferObserved(evidence) {
  return evidence?.manualDraftTransfer?.observed === true
    && evidence?.manualDraftTransfer?.method === 'manual-paste'
    && evidence?.manualDraftTransfer?.autoFilled !== true
}

function officialComposerSendObserved(evidence) {
  return evidence?.officialComposerSend?.observed === true
    && evidence?.officialComposerSend?.channel === 'official-web-composer'
}

function cancelRecoveryObserved(evidence) {
  return evidence?.cancelRecovery?.observed === true
    && evidence?.cancelRecovery?.cancelled === true
    && evidence?.cancelRecovery?.recovered === true
}

function publicPollutionProbesObserved(evidence) {
  const probes = evidence?.pollutionProbes
  if (probes?.source !== 'public') return false
  return ['transcript', 'queue', 'pending', 'plan', 'goal']
    .every((name) => probes?.[name] === 'unchanged')
}

function isObservedPublic(value, kind) {
  if (value?.available !== true || value?.status !== 'observed') return false
  if (kind === 'sessionCount') return isObservedCountBand(value.band)
  if (kind === 'officialUsage') return isObservedUsageBand(value.band)
  if (kind === 'blankTurns') return typeof value.blank === 'boolean' && typeof value.hasTurns === 'boolean'
  if (typeof value.band === 'string') return isObservedCountBand(value.band) || isObservedUsageBand(value.band)
  return typeof value.blank === 'boolean' && typeof value.hasTurns === 'boolean'
}

function isObservedCountBand(band) {
  return T7_COUNT_BANDS.has(band) && band !== 'unavailable'
}

function isObservedUsageBand(band) {
  return T7_USAGE_BANDS.has(band) && band !== 'unavailable'
}

function publicCompareFields(value) {
  const out = {}
  for (const key of ['band', 'blank', 'hasTurns']) {
    if (Object.hasOwn(value, key)) out[key] = value[key]
  }
  return out
}

function collectForbidden(value, errors, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbidden(item, errors, [...trail, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    const coarse = nested === 'succeeded' || nested === 'failed' || nested === 'unavailable' || nested === 'unchanged' || nested === 'changed' || nested === 'observed' || typeof nested === 'boolean'
    if (T7_FORBIDDEN_KEYS.has(key) && !coarse) errors.push(`forbidden key ${[...trail, key].join('.')}`)
    if (typeof nested === 'number' && /token|usage|count/i.test(key)) {
      errors.push(`raw numeric ${[...trail, key].join('.')}`)
    }
    collectForbidden(nested, errors, [...trail, key])
  }
}

function pickDefined(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source?.[key] !== undefined) out[key] = source[key]
  }
  return out
}

function optionValue(argv, name) {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  return argv[index + 1]
}

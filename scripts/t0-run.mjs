#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ensureOfficialDsh,
  helpText,
  isolatedHome,
  parseDshSpec,
  probeWorkDir,
  publicOrigin,
  redact,
  root,
  runDsh,
  spawnDsh,
  stopChild,
  summarizeDump,
  waitForPrintedOrigin,
  writeEvidence,
} from './lib/harness.mjs'
import { callClarify, createTestFixtureSession, discoverExistingSession, labelHostT3Session } from './lib/remote-client.mjs'
import { gateTable, isBusinessRemoteArrival, isInfrastructureRemoteFailure } from './lib/verdicts.mjs'
import { readResolvedGraph } from './lib/graph.mjs'
import { sanitize } from './lib/sanitize.mjs'

const spec = parseDshSpec(process.argv)
const version = spec.version
const commands = []

function capture(name, fn) {
  try {
    const output = fn()
    const full = String(output ?? '')
    commands.push({ name, ok: true, output: redact(truncate(full)), raw: full })
    return { ok: true, output: full }
  } catch (error) {
    const output = redact(truncate(combinedError(error)))
    commands.push({ name, ok: false, output, exitCode: error.status ?? error.code })
    return { ok: false, output, error }
  }
}

function truncate(text, max = 12_000) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value
}

function combinedError(error) {
  return [error.message, error.stdout, error.stderr].filter(Boolean).join('\n')
}

const dshBin = await ensureOfficialDsh(version)
const graph = readResolvedGraph(join(root, '.probe-work', version, 'dsh-install'))
const home = isolatedHome(version, 't0')
writeFileSync(join(home, '.clarify-probe'), '1\n')
const env = {
  DSH_HOME: home,
  CLARIFY_PROBE: '1',
  CLARIFY_PROBE_DSH_VERSION: version,
}
const dshVersion = capture('dsh --version', () => runDsh(dshBin, ['--version'], env))
const dshHelp = capture('dsh --help', () => helpText(dshBin, env))

execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const packDir = mkdtempSync(join(tmpdir(), 'clarify-t0-pack-'))
execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: root, stdio: 'inherit' })
const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (packageManifest.name !== 'dsh-plugin-clarify' || typeof packageManifest.version !== 'string') {
  throw new Error('package.json must identify a versioned dsh-plugin-clarify package')
}
const tgz = join(packDir, `${packageManifest.name}-${packageManifest.version}.tgz`)

capture('init dump-config', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))
const add = capture('plugin add tgz', () => runDsh(dshBin, ['plugin', '--profile', 'web', 'add', tgz], env))
const dump = capture('dump-config after add', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))

const http = {
  clarify: null,
  probe: null,
  remote: null,
  hostT3: null,
  bootOutput: '',
}
const child = spawnDsh(dshBin, ['--profile', 'web', '--port', '0'], env)
let bootOutput = ''
child.stdout.on('data', (chunk) => { bootOutput += chunk.toString() })
child.stderr.on('data', (chunk) => { bootOutput += chunk.toString() })
try {
  const matchWait = await waitForPrintedOrigin(child, () => bootOutput, 90_000)
  http.clarify = await fetchJsonOrText(new URL('/clarify', matchWait.origin).href)
  http.probe = await fetchJsonOrText(new URL('/clarify/probe', matchWait.origin).href)
  http.remote = await callClarify(matchWait.origin, 'start', { sessionId: 'missing-session' })
  http.hostT3 = await runHostT3(matchWait.origin, http.probe?.json?.usage ?? {})
  http.origin = matchWait.origin
} catch (error) {
  http.bootError = error instanceof Error ? error.message : String(error)
} finally {
  http.bootOutput = redact(truncate(bootOutput))
  await stopChild(child)
}

http.clarifyOk = isClarifyDiy(http.clarify?.text)
http.probeOk = isProbeJson(http.probe?.json)
http.remoteLive = isRemoteLive(http.remote)
http.summaries = {
  origin: publicOrigin(http.origin),
  bootError: http.bootError ? redact(http.bootError) : undefined,
  clarify: { status: http.clarify?.status, diy: http.clarifyOk },
  probe: { status: http.probe?.status, json: http.probeOk },
  remote: {
    status: http.remote?.status,
    live: http.remoteLive,
    errorCode: http.remote?.error?.code,
    envelope: http.remote?.json?.type,
  },
    hostT3: http.hostT3,
}

const dumpFull = dump.output ?? ''
const evidence = {
  dshVersion: version,
  dshSpecSource: spec.source,
  requested: {
    metaVersion: version,
    source: spec.source,
    distTag: spec.source === 'latest' || spec.source === 'next' ? spec.source : undefined,
  },
  observedCliVersion: String(dshVersion.output ?? '').trim() || undefined,
  componentGraph: graph,
  commands: commands.map((item) => ({
    name: item.name,
    ok: item.ok,
    exitCode: item.exitCode,
    output: item.name.includes('dump-config')
      ? summarizeDump(item.raw ?? item.output)
      : truncate(item.output, 4000),
  })),
  pluginAddOk: add.ok,
  dumpContainsClarify: Boolean(dumpFull.includes('dsh-plugin-clarify') || dumpFull.includes('# == dsh-plugin-clarify')),
  http: http.summaries,
}
writeEvidence(version, 'lane.json', {
  requested: evidence.requested,
  observedCliVersion: evidence.observedCliVersion,
  componentGraph: graph,
})
writeEvidence(version, 'commands.json', evidence)
writeHttpRaw(version, 'http-clarify', http.clarify)
writeHttpRaw(version, 'http-probe', http.probe)
writeHttpRaw(version, 'http-remote', http.remote)
if (http.probeOk) writeEvidence(version, 'probe.json', http.probe.json)
else if (http.probe) {
  writeEvidence(version, 'probe-error.txt', [
    `status=${http.probe.status}`,
    `json=${http.probe.json ? 'yes' : 'no'}`,
    truncate(http.probe.text ?? '', 4000) || '(empty body)',
  ].join('\n'))
}
if (http.remote?.json) writeEvidence(version, 'remote-start.json', http.remote.json)
if (http.hostT3) writeEvidence(version, 'host-t3.json', http.hostT3)
writeEvidence(version, 'dump-clarify.txt', summarizeDump(dumpFull))
writeEvidence(version, 'help.txt', (dshHelp.output ?? '').trimEnd())
writeEvidence(version, 'boot.txt', http.bootOutput ?? '')

const report = writeBlockingReport(version, {
  ...evidence,
  httpProbe: http.probeOk ? http.probe.json : undefined,
  clarifyDiy: http.clarifyOk,
  remoteLive: http.remoteLive,
  httpRemote: http.remote,
})
writeEvidence(version, 'gates.json', {
  a: report.a.status,
  b: report.b.status,
  c: report.c.status,
  d: report.d.status,
  reasons: {
    a: report.a.reason,
    b: report.b.reason,
    c: report.c.reason,
    d: report.d.reason,
  },
  hostT3: {
    ok: http.hostT3?.ok === true,
    blocked: http.hostT3?.blocked === true,
    envelopeLive: http.hostT3?.envelopeLive === true,
    reason: http.hostT3?.reason ?? http.hostT3?.note,
    sessionSource: http.hostT3?.sessionDiscovery?.source,
    createdByHarness: http.hostT3?.sessionDiscovery?.createdByHarness === true,
    productionPluginCreated: false,
  },
  remoteLive: http.remoteLive,
})
writeIndexReport()
rmSync(packDir, { recursive: true, force: true })
console.log(`T0 evidence written under docs/t0-evidence/${version}`)
console.log(`probe workdir .probe-work/${version} (gitignored)`)
console.log(`gates ${report.a.status}/${report.b.status}/${report.c.status}/${report.d.status}`)

function writeHttpRaw(version, name, result) {
  if (!result) {
    writeEvidence(version, `${name}.json`, { missing: true })
    return
  }
  writeEvidence(version, `${name}.json`, {
    url: result.url?.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/, 'http://127.0.0.1:<ephemeral>') ?? result.url,
    status: result.status,
    headers: sanitizeHeaders(result.headers),
    json: Boolean(result.json),
    live: result.live,
    ok: result.ok,
    errorCode: result.error?.code,
    textPreview: truncate(sanitize(result.text ?? result.textPreview ?? ''), 4000),
  })
}

function sanitizeHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (/cookie|authorization|token|secret/i.test(key)) continue
    out[key] = key.toLowerCase() === 'date' ? '<ephemeral>' : sanitize(value)
  }
  return out
}

async function fetchJsonOrText(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers),
    text: truncate(text, 8000),
    json,
  }
}

async function runHostT3(origin, probeUsage = {}) {
  const endpoints = {
    start: summarizeRemote(await callClarify(origin, 'start', { sessionId: 'missing-session' })),
    answer: summarizeRemote(await callClarify(origin, 'answer', { processId: 'missing-process', questionId: 'q' })),
    accept: summarizeRemote(await callClarify(origin, 'accept', { processId: 'missing-process', previewVersion: 'missing-preview' })),
    refine: summarizeRemote(await callClarify(origin, 'refine', { processId: 'missing-process', previewVersion: 'missing-preview', feedback: 'probe' })),
    cancel: summarizeRemote(await callClarify(origin, 'cancel', { processId: 'missing-process' })),
    fetchDraft: summarizeRemote(await callClarify(origin, 'fetchDraft', { processId: 'missing-process' })),
  }
  const envelopeLive = Object.values(endpoints).every((item) => (
    item.envelope === 'server-response'
    && !isInfrastructureRemoteFailure({
      code: item.errorCode,
      httpStatus: item.status,
      message: item.errorMessage,
    })
    && (item.ok === true || isBusinessRemoteArrival({
      code: item.errorCode,
      httpStatus: item.status,
      message: item.errorMessage,
    }))
  ))
  if (!envelopeLive) {
    return {
      ok: false,
      blocked: true,
      interactive: false,
      reason: 'official /api/clarify/* did not return Clarify business envelopes; HTTP 404 / invocation-unavailable are infrastructure blocks, not a T3 round',
      endpoints,
      envelopeLive,
      sessionDiscovery: labelHostT3Session({ created: false, attempted: false }, probeUsage),
      note: 'GET /clarify static HTML is not an interactive T3 pass. Full-round fixture session is only created after the six endpoints are live. Production plugin and DIY must not create Session.',
    }
  }
  let discovery = await discoverExistingSession(origin)
  if (!discovery.sessionId) {
    discovery = await createTestFixtureSession(origin)
  }
  const sessionDiscovery = labelHostT3Session(discovery, probeUsage)
  if (!discovery.sessionId) {
    return {
      ok: false,
      blocked: true,
      interactive: false,
      reason: discovery.reason,
      endpoints,
      envelopeLive,
      sessionDiscovery,
      note: 'GET /clarify static HTML is not an interactive T3 pass; official /api envelopes were exercised above. session.create was only attempted as an isolated T3 test fixture. Production plugin and DIY must not create Session.',
    }
  }
  const started = await callClarify(origin, 'start', {
    sessionId: discovery.sessionId,
    seedText: 'need an off-transcript clarify process',
  })
  const q1 = started.value
  const answered1 = q1?.question
    ? await callClarify(origin, 'answer', {
      processId: q1.processId,
      questionId: q1.question.questionId,
      selectedOptionIds: ['o-feature'],
    })
    : { ok: false, error: { message: 'start returned no question' } }
  const q2 = answered1.value
  const completed = q2?.question
    ? await callClarify(origin, 'answer', {
      processId: q1.processId,
      questionId: q2.question.questionId,
      selectedOptionIds: ['o-compat', 'o-time'],
    })
    : { ok: false, error: { message: 'answer-1 returned no question' } }
  const fetched = completed.value?.status === 'complete'
    ? await callClarify(origin, 'fetchDraft', { processId: q1.processId })
    : { ok: false, error: { message: 'complete was not reached' } }
  const cancelled = q1?.processId
    ? await callClarify(origin, 'cancel', { processId: q1.processId })
    : { ok: false, error: { message: 'no processId to cancel' } }
  const errors = [started.error, answered1.error, completed.error, fetched.error].filter(Boolean)
  const ok = Boolean(started.ok && answered1.ok && completed.ok && fetched.ok && fetched.value?.draft && completed.value?.draft === undefined)
  return {
    ok,
    blocked: !ok && errors.some((error) => error?.category === 'configuration'),
    reason: ok
      ? undefined
      : errors.map((error) => `${error?.code ?? 'error'}: ${error?.message ?? 'unknown failure'}`).join('; '),
    interactive: false,
    envelopeLive,
    endpoints,
    sessionDiscovery,
    steps: {
      start: started.value?.status,
      answer1: answered1.value?.status,
      complete: completed.value?.status,
      draftPresent: typeof fetched.value?.draft === 'string',
      completeHadDraft: completed.value?.draft !== undefined,
      cancel: cancelled.value?.status,
    },
    errors,
    note: hostT3Note(sessionDiscovery),
  }
}

function hostT3Note(sessionDiscovery) {
  const source = sessionDiscovery?.source ?? 'none'
  return `GET /clarify static HTML is not an interactive T3 pass. Session source=${source}, createdByHarness=${sessionDiscovery?.createdByHarness === true}, productionPluginCreated=false. Isolation test fixture only; production plugin and DIY must not create Session.`
}

function summarizeRemote(result) {
  return {
    status: result?.status,
    envelope: result?.json?.type,
    ok: result?.ok === true,
    errorCode: result?.error?.code,
    errorMessage: result?.error?.message,
    live: result?.json?.type === 'server-response' && !isInfrastructureRemoteFailure({
      code: result?.error?.code,
      httpStatus: result?.status,
      message: result?.error?.message ?? result?.textPreview,
    }),
  }
}

function writeBlockingReport(version, evidence) {
  const probe = evidence.httpProbe ?? {}
  const usage = probe.usage ?? {}
  const header = probe.header ?? {}
  const web = probe.web ?? {}
  const gates = gateTable(probe, {
    http: evidence.http,
    remoteLive: evidence.remoteLive,
    httpRemote: evidence.httpRemote,
  })
  const md = `# T0 阻塞报告（${version}）

> 本报告只记录本次实际观察到的结果。未观察到的能力一律标为阻塞，不标通过。
> 公开兼容表只把实际跑过合同的精确版本标为已验证。future / latest / next 是动态发现，不是对未发布版本的保证。

## 环境

- 请求的元包：\`@deepseek-ai/dsh@${version}\`（来源 \`${evidence.dshSpecSource ?? 'version'}\`${evidence.requested?.distTag ? ` / dist-tag ${evidence.requested.distTag}` : ''}）
- 观察到的 CLI \`--version\`：\`${String(evidence.observedCliVersion ?? '').trim() || '未观察到'}\`
- 解析组件：base \`${evidence.componentGraph?.core?.['@deepseek-ai/dsh-base'] ?? 'n/a'}\`；typert-protocol \`${evidence.componentGraph?.core?.['@deepseek-ai/dsh-typert-protocol'] ?? 'n/a'}\`；web-app \`${evidence.componentGraph?.core?.['@deepseek-ai/dsh-web-app'] ?? 'n/a'}\`
- 混合树：\`${evidence.componentGraph?.mixed ? 'yes' : 'no'}\` — ${evidence.componentGraph?.note ?? ''}
- 隔离 \`DSH_HOME\`：\`.probe-work/${version}/homes/t0\`（gitignored，不输出 Profile/凭据/本机绝对路径）

## 闸门 (a)–(d)

| 闸门 | 结论 | 证据 |
| --- | --- | --- |
| (a) off-transcript, no-tools 补全 | ${gates.a.status} | ${gates.a.reason} |
| (b) 只读上下文及修订标识 | ${gates.b.status} | ${gates.b.reason} |
| (c) Surface 可发现 Remote | ${gates.c.status} | ${gates.c.reason} |
| (d) usage / limits / cancel 通道 | ${gates.d.status} | ${gates.d.reason} |

## P-usage

- 状态：\`${usage.status ?? '未运行'}\`
- \`ctx.llm.stream\`：\`${probe.llmSurface?.hasStream ?? 'unknown'}\`
- 无 Agent-loop 标记：\`${usage.requestWasAgentLoop === false}\`
- 事件条数变化：\`${usage.eventCountDelta ?? 'n/a'}\`
- deriveMessages 条数变化：\`${usage.derivedDelta ?? 'n/a'}\`
- Session 来源：\`${usage.sessionSource ?? 'n/a'}\`
- TokenMeter totalTokens：\`${usage.usageMeasureBefore?.totalTokens ?? 'n/a'} -> ${usage.usageMeasureAfter?.totalTokens ?? 'n/a'}\`
- tokenUsage 投影：\`${JSON.stringify(usage.usageProjectionBefore ?? null)} -> ${JSON.stringify(usage.usageProjectionAfter ?? null)}\`
- 本次探针期望增量：\`total=${usage.expectedTotalTokensDelta ?? 'n/a'} / ${JSON.stringify(usage.expectedUsageProjectionDelta ?? null)}\`
- limits 通道：\`${usage.limits?.status ?? 'unproven'}\` — ${usage.limits?.reason ?? ''}
- cancel 通道：\`${usage.cancellation?.status ?? 'unproven'}\` — ${usage.cancellation?.reason ?? ''}
- stream 错误：\`${usage.streamError ?? 'none'}\`
- adapter 错误：\`${usage.adapterError ?? 'none'}\`

## P-header

- 状态：\`${header.status ?? '未运行'}\`
- 新鲜 Session 上 \`requestHeader()\`：\`${header.hasRequestHeader ?? 'unknown'}\`
- header keys：\`${(header.headerKeys ?? []).join(', ') || 'none'}\`
- config keys：\`${(header.configKeys ?? []).join(', ') || 'none'}\`
- 存在 \`session.seq\`：\`${header.hasSessionSeq ?? 'unknown'}\`（禁止用作 contextVersion）
- 无新消息改 system/tools：\`${header.liveSystemToolsChangeWithoutNewMessages?.status ?? 'unobserved'}\` — ${header.liveSystemToolsChangeWithoutNewMessages?.reason ?? ''}

## P-web

- Host DIY \`GET /clarify\`：HTTP ${evidence.http?.clarify?.status ?? '未观察到'}；DIY 签名 ${evidence.http?.clarify?.diy ? '匹配' : '不匹配'}
- \`GET /clarify/probe\`：HTTP ${evidence.http?.probe?.status ?? '未观察到'}；合同 JSON ${evidence.http?.probe?.json ? '是' : '否'}
- stock \`POST /api/clarify/start\`：HTTP ${evidence.http?.remote?.status ?? '未观察到'}；Remote 信封 ${evidence.http?.remote?.live ? '已观察到' : '未证明'}
- Host T3（官方 \`/api\` 信封实跑）：${evidence.http?.hostT3?.ok ? '通过' : (evidence.http?.hostT3?.blocked ? '阻塞' : '失败')} — ${evidence.http?.hostT3?.reason ?? evidence.http?.hostT3?.note ?? ''}
- Host T3 Session：source=\`${evidence.http?.hostT3?.sessionDiscovery?.source ?? 'n/a'}\`；createdByHarness=\`${evidence.http?.hostT3?.sessionDiscovery?.createdByHarness === true}\`；productionPluginCreated=\`false\`。仅隔离测试夹具；插件与 DIY 仍禁止 \`session.create\`。
- DIY 静态签名不等于交互通过：\`${evidence.http?.clarify?.diy ? '签名匹配' : '签名不匹配'}\`；交互 T7 未声称通过
- \`webServer.register\`：\`${web.hasRegister ?? 'unknown'}\`
- \`ctx.typert.register\`：\`${web.hasTypertRegister ?? 'unknown'}\`
- \`typert.local\` claim 六端点：\`${web.clarifyRemoteClaimed === true}\`；列出 \`${Array.isArray(web.typertLocalEndpoints) ? web.typertLocalEndpoints.filter((item) => String(item).startsWith('clarify/')).join(', ') || 'none' : 'n/a'}\`
- Remote 注册：\`${web.remoteRegistration?.status ?? 'n/a'}\`${web.remoteRegistration?.reason ? ` — ${web.remoteRegistration.reason}` : ''}
- Gateway 到达：\`${web.consumerPath?.status ?? 'unknown'}\` / \`${web.consumerPath?.observed ?? 0}\`；仅 business hit 算抵达
- \`typertGateway.invoke\`：\`${web.hasTypertGatewayInvoke ?? web.hasTypertGateway ?? 'unknown'}\`
- \`ctx.remote.$mount\`：\`${web.hasRemoteMount ?? 'unknown'}\`（Client face，Host DIY 不依赖它）
- stock Web 插件 UI 挂载点：${web.stockWebPluginUiMount?.reason ?? '未观察'}

## 对 T4+ 的影响

${[gates.a, gates.b, gates.c, gates.d].some((item) => item.status !== '可行')
    ? '该精确版本的 T4 及以后按任务书停止真实推理接入，直到上表阻塞项由官方 dsh 公开 API 补齐。T1–T3 骨架、状态机与桩 Remote 继续交付。'
    : '本次未记录 (a)–(d) 阻塞。T4 仍须在独立回合用真实补全重跑 transcript 零污染合同，不得沿用本报告作为 T4 通过证明。'}

## 命令记录

${evidence.commands.map((item) => `- ${item.ok ? 'OK' : 'FAIL'} \`${item.name}\``).join('\n')}
`
  writeFileSync(join(root, 'docs', 't0-evidence', version, 't0-blocking-report.md'), md)
  return gates
}

function writeIndexReport() {
  const md = `# T0 阻塞报告索引

> 每份精确版本的结论只存在于 \`docs/t0-evidence/<version>/t0-blocking-report.md\`。
> 本文件不复制未重跑版本的闸门结论。动态 \`latest\` / \`next\` 只用于发现矩阵，不构成对未发布版本的保证。

重跑：

- \`pnpm t0:matrix\`
- \`pnpm t0 -- --dsh-version 0.1.0-rc.6\`
- \`pnpm t0 -- --dsh-version 0.1.0-rc.7\`
- \`pnpm t0 -- --dsh-version 0.1.0-rc.8\`
- \`pnpm t0 -- --dsh-tag latest\`
- \`pnpm t0 -- --dsh-tag next\`（仅当 next ≠ latest）

矩阵摘要：\`docs/t0-matrix-summary.md\`（由 \`pnpm t0:matrix\` 生成，不覆盖各版本目录）。
`
  writeFileSync(join(root, 'docs', 't0-blocking-report.md'), md)
}

function isClarifyDiy(body) {
  return typeof body === 'string'
    && body.includes('window.CLARIFY_REMOTE')
    && body.includes('/api/')
    && body.includes('clarify')
    && !body.includes('/clarify/rpc')
    && !body.includes('session.prompt')
    && !body.includes('session.create')
}

function isProbeJson(payload) {
  return Boolean(payload && typeof payload === 'object' && payload.capturedAt && payload.usage && payload.header && payload.web)
}

function isRemoteLive(remote) {
  if (!remote) return false
  if (isInfrastructureRemoteFailure({
    message: remote.text ?? remote.textPreview ?? remote.error?.message,
    code: remote.error?.code,
    httpStatus: remote.status,
  })) return false
  if (remote.json?.type === 'server-response') {
    return remote.ok === true || isBusinessRemoteArrival({
      code: remote.error?.code,
      message: remote.error?.message,
      value: remote.value ?? remote.json?.result?.value,
    })
  }
  return false
}

void sanitize

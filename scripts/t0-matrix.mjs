#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matrixFromTags, readDistTags } from './lib/versions.mjs'
import { sanitizeText } from './lib/sanitize.mjs'
import { hostT3SessionSource, t1DoctorVerdict, t1LifecycleVerdict, t1StandaloneExitOk, t1StandaloneVerdict, t1Verdict } from './lib/matrix-row.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const tags = readDistTags()
const matrix = matrixFromTags(tags)
const fromEvidence = process.argv.includes('--from-evidence')
console.log(`dist-tags ${matrix.snapshot}`)
console.log(`contract versions ${matrix.versions.join(', ')}`)
if (fromEvidence) console.log('from-evidence: refresh summaries only, do not re-run Host')

const kind = process.argv.includes('t1') ? 't1' : 't0'
const script = kind === 't1' ? 't1-lifecycle.mjs' : 't0-run.mjs'
const rows = []
let failed = 0
for (const version of matrix.versions) {
  if (!fromEvidence) {
    console.log(`\n=== ${script} @ ${version} ===`)
    const result = spawnSync(process.execPath, [`scripts/${script}`, '--dsh-version', version], {
      cwd: root,
      stdio: 'inherit',
    })
    const exit = result.status ?? 1
    if (exit !== 0) {
      failed += 1
      console.error(`BLOCK/FAIL ${script} ${version} exit ${exit}`)
    }
    rows.push(readLaneRow(version, kind, exit))
  } else {
    const row = readLaneRow(version, kind, inferredExit(version, kind))
    if (row.exit !== 0) failed += 1
    rows.push(row)
  }
}
writeMatrixSummary(kind, matrix, rows, failed)
if (failed > 0) process.exitCode = 1
console.log(`\nmatrix done: ${matrix.versions.length - failed}/${matrix.versions.length} processes exited 0`)

function inferredExit(version, kind) {
  if (kind === 't1') {
    const t1Path = join(root, 'docs', 't0-evidence', version, 't1-lifecycle.json')
    if (!existsSync(t1Path)) return 1
    try {
      const t1 = JSON.parse(readFileSync(t1Path, 'utf8'))
      return t1StandaloneExitOk(t1) ? 0 : 1
    } catch {
      return 1
    }
  }
  const reportPath = join(root, 'docs', 't0-evidence', version, 't0-blocking-report.md')
  return existsSync(reportPath) ? 0 : 1
}

function readLaneRow(version, kind, exit) {
  const dir = join(root, 'docs', 't0-evidence', version)
  const lanePath = join(dir, 'lane.json')
  const gatesPath = join(dir, 'gates.json')
  const t1Path = join(dir, 't1-lifecycle.json')
  const hostT3Path = join(dir, 'host-t3.json')
  const t1Report = existsSync(join(dir, 't1-report.md'))
    ? `docs/t0-evidence/${version}/t1-report.md`
    : (existsSync(t1Path) ? `docs/t0-evidence/${version}/t1-lifecycle.json` : 'missing')
  const t0Report = existsSync(join(dir, 't0-blocking-report.md'))
    ? `docs/t0-evidence/${version}/t0-blocking-report.md`
    : 'missing'
  let lane = {}
  let gates = {}
  let t1 = {}
  let hostT3 = {}
  if (existsSync(lanePath)) {
    try { lane = JSON.parse(readFileSync(lanePath, 'utf8')) } catch { lane = {} }
  }
  if (existsSync(gatesPath)) {
    try { gates = JSON.parse(readFileSync(gatesPath, 'utf8')) } catch { gates = {} }
  }
  if (existsSync(t1Path)) {
    try { t1 = JSON.parse(readFileSync(t1Path, 'utf8')) } catch { t1 = {} }
  }
  if (existsSync(hostT3Path)) {
    try { hostT3 = JSON.parse(readFileSync(hostT3Path, 'utf8')) } catch { hostT3 = {} }
  }
  return {
    version,
    exit,
    requested: lane.requested ?? { metaVersion: version, source: 'version' },
    observedCliVersion: lane.observedCliVersion ?? null,
    mixed: lane.componentGraph?.mixed ?? null,
    base: lane.componentGraph?.core?.['@deepseek-ai/dsh-base'] ?? null,
    a: gates.a ?? 'n/a',
    b: gates.b ?? 'n/a',
    c: gates.c ?? 'n/a',
    d: gates.d ?? 'n/a',
    hostT3: gates.hostT3?.ok === true ? '通过' : (gates.hostT3?.blocked ? '阻塞' : (gates.hostT3 ? '失败' : 'n/a')),
    hostT3Session: hostT3SessionSource(gates, hostT3),
    lifecycle: t1StandaloneVerdict(t1),
    doctor: t1DoctorVerdict(t1),
    t1: t1Verdict(t1),
    report: kind === 't0' ? t0Report : t1Report,
  }
}

function writeMatrixSummary(kind, matrix, rows, failed) {
  const isT0 = kind === 't0'
  const lines = [
    `# ${kind.toUpperCase()} 矩阵摘要`,
    '',
    `> 生成于矩阵跑完之后。各精确版本结论只写在 \`docs/t0-evidence/<version>/\`，本文件不覆盖那些目录。`,
    `> dist-tags 快照：\`${matrix.snapshot}\`。\`latest\` / \`next\` 是动态发现，不是对未发布版本的保证。`,
    isT0
      ? `> 子进程退出 0 不等于闸门可行。(b)/(d) 阻塞则该版本 T4+ 停止。Host T3「通过」只表示官方 /api 信封完整回合；Session 是隔离测试夹具，见 T3 Session 列。`
      : `> standalone T1 只陈述 stock add/boot/remove/re-add lifecycle。任务书 /doctor 零错误零警告是 final cross-project acceptance，待 Task B 既有本地 /doctor 联调。在联调证据存在前不得把 T1 写成完全通过。stock dsh 无 doctor 不得使本矩阵永久红。`,
    '',
    `pinned release lanes: \`${matrix.versions.join('`, `')}\``,
    '',
    ...(isT0
      ? [
        '| 请求元包 | CLI | base | 混合树 | (a) | (b) | (c) | (d) | Host T3 | T3 Session | 退出码 | 分版本报告 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((row) => `| ${row.version} | ${row.observedCliVersion ?? 'n/a'} | ${row.base ?? 'n/a'} | ${row.mixed === null ? 'n/a' : row.mixed} | ${row.a} | ${row.b} | ${row.c} | ${row.d} | ${row.hostT3} | ${row.hostT3Session} | ${row.exit} | ${row.report} |`),
      ]
      : [
        '| 请求元包 | CLI | base | 混合树 | standalone lifecycle | cross-project doctor | T1 完全通过 | 退出码 | 分版本报告 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map((row) => `| ${row.version} | ${row.observedCliVersion ?? 'n/a'} | ${row.base ?? 'n/a'} | ${row.mixed === null ? 'n/a' : row.mixed} | ${row.lifecycle} | ${row.doctor} | ${row.t1} | ${row.exit} | ${row.report} |`),
      ]),
    '',
    isT0
      ? 'T0 子进程退出 0 只表示探针跑完并写了报告，不是 (a)–(d) 全绿。'
      : `T1 standalone 退出 0：${rows.filter((row) => row.lifecycle === '通过').length}/${rows.length}。T1 完全通过：${rows.filter((row) => row.t1 === '通过').length}/${rows.length}。cross-project doctor 待联调不得把 standalone 合同打红。`,
    `记录的退出码 0：${rows.length - failed}/${rows.length}`,
    '',
  ]
  writeFileSync(join(root, 'docs', `${kind}-matrix-summary.md`), sanitizeText(lines.join('\n')))
}

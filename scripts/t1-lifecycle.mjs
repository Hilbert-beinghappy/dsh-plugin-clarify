#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ensureOfficialDsh,
  inspectClarifyDump,
  isolatedHome,
  parseDshSpec,
  redact,
  root,
  runDsh,
  spawnDsh,
  stopChild,
  waitForPrintedOrigin,
  writeEvidence,
} from './lib/harness.mjs'
import { dumpEvidenceContradictions } from './lib/dump.mjs'
import {
  formatT1Report,
  pendingCrossProjectDoctor,
  t1CompleteVerdict,
  t1StandaloneVerdict,
} from './lib/t1-verdicts.mjs'
import { callClarify } from './lib/remote-client.mjs'
import { readResolvedGraph } from './lib/graph.mjs'

const spec = parseDshSpec(process.argv)
const version = spec.version
const steps = []
const dumps = {}

function step(name, fn) {
  try {
    const output = fn()
    steps.push({ name, ok: true, output: redact(String(output ?? '').slice(0, 4000)) })
    console.log(`PASS ${name}`)
    return output
  } catch (error) {
    const output = redact([error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, 4000))
    steps.push({ name, ok: false, output, exitCode: error.status ?? error.code })
    console.log(`FAIL ${name}`)
    return undefined
  }
}

function dumpStep(name, rawOrFn) {
  try {
    const raw = typeof rawOrFn === 'function' ? rawOrFn() : rawOrFn
    const inspected = inspectClarifyDump(raw)
    dumps[name] = { raw: String(raw ?? ''), ...inspected }
    steps.push({
      name,
      ok: true,
      output: inspected.excerpt,
      dumpPresent: inspected.present,
      dumpLength: inspected.length,
    })
    console.log(`PASS ${name}`)
    return dumps[name]
  } catch (error) {
    const output = redact([error.message, error.stdout, error.stderr].filter(Boolean).join('\n').slice(0, 4000))
    dumps[name] = { raw: '', present: false, excerpt: 'dsh-plugin-clarify not found' }
    steps.push({ name, ok: false, output, exitCode: error.status ?? error.code })
    console.log(`FAIL ${name}`)
    return dumps[name]
  }
}

const dshBin = await ensureOfficialDsh(version)
const graph = readResolvedGraph(join(root, '.probe-work', version, 'dsh-install'))
const home = isolatedHome(version, 't1')
const env = { DSH_HOME: home }

execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
const packDir = mkdtempSync(join(tmpdir(), 'clarify-t1-pack-'))
execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: root, stdio: 'inherit' })
const tgz = join(packDir, 'dsh-plugin-clarify-0.1.0.tgz')

step('dsh --version', () => runDsh(dshBin, ['--version'], env))
dumpStep('init web dump-config', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))
step('plugin add', () => runDsh(dshBin, ['plugin', '--profile', 'web', 'add', tgz], env))
const dumpAfterAdd = dumpStep('dump-config after add', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))

const boot = await bootOnce(dshBin, env)
steps.push(boot)
console.log(`${boot.ok ? 'PASS' : 'FAIL'} boot web after add`)

step('plugin remove', () => runDsh(dshBin, ['plugin', '--profile', 'web', 'remove', 'dsh-plugin-clarify'], env))
const dumpAfterRemove = dumpStep('dump-config after remove', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))
if (dumpAfterRemove.present) {
  steps.push({
    name: 'dump-config after remove has no clarify layer',
    ok: false,
    output: dumpAfterRemove.excerpt,
  })
  console.log('FAIL dump-config after remove has no clarify layer')
} else {
  steps.push({
    name: 'dump-config after remove has no clarify layer',
    ok: true,
    output: dumpAfterRemove.excerpt,
  })
  console.log('PASS dump-config after remove has no clarify layer')
}
step('plugin add again', () => runDsh(dshBin, ['plugin', '--profile', 'web', 'add', tgz], env))
const dumpAfterReadd = dumpStep('dump-config after re-add', () => runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))

const dumpContainsClarifyAfterAdd = dumpAfterAdd.present
const dumpContainsClarifyAfterRemove = dumpAfterRemove.present
const dumpContainsClarifyAfterReadd = dumpAfterReadd.present
if (!dumpContainsClarifyAfterAdd) {
  steps.push({
    name: 'dump-config after add contains clarify',
    ok: false,
    output: dumpAfterAdd.excerpt,
  })
  console.log('FAIL dump-config after add contains clarify')
}
if (!dumpContainsClarifyAfterReadd) {
  steps.push({
    name: 'dump-config after re-add contains clarify',
    ok: false,
    output: dumpAfterReadd.excerpt,
  })
  console.log('FAIL dump-config after re-add contains clarify')
}
const contradictions = dumpEvidenceContradictions([
  {
    label: 'dump-config after add',
    raw: dumpAfterAdd.raw,
    present: dumpContainsClarifyAfterAdd,
    excerpt: dumpAfterAdd.excerpt,
  },
  {
    label: 'dump-config after remove',
    raw: dumpAfterRemove.raw,
    present: dumpContainsClarifyAfterRemove,
    excerpt: dumpAfterRemove.excerpt,
  },
  {
    label: 'dump-config after re-add',
    raw: dumpAfterReadd.raw,
    present: dumpContainsClarifyAfterReadd,
    excerpt: dumpAfterReadd.excerpt,
  },
])
const dumpConsistency = {
  ok: contradictions.length === 0,
  contradictions,
}
steps.push({
  name: 'dump evidence consistency',
  ok: dumpConsistency.ok,
  output: dumpConsistency.ok ? 'boolean/text agree on full dumps' : contradictions.join('\n'),
})
console.log(`${dumpConsistency.ok ? 'PASS' : 'FAIL'} dump evidence consistency`)

const lifecycleFailed = steps.filter((item) => !item.ok).map((item) => item.name)
const lifecycleVerdict = lifecycleFailed.length === 0 ? '通过' : '阻塞'
const doctor = pendingCrossProjectDoctor()
const draft = {
  lifecycle: {
    verdict: lifecycleVerdict,
    failed: lifecycleFailed,
  },
  doctor,
  dumpConsistency,
  steps,
}
const standaloneVerdict = t1StandaloneVerdict(draft)
const completeVerdict = t1CompleteVerdict(draft)

writeEvidence(version, 'lane.json', {
  requested: {
    metaVersion: version,
    source: spec.source,
    distTag: spec.source === 'latest' || spec.source === 'next' ? spec.source : undefined,
  },
  observedCliVersion: steps.find((item) => item.name === 'dsh --version')?.output?.trim(),
  componentGraph: graph,
})
const evidence = {
  dshVersion: version,
  dshSpecSource: spec.source,
  requested: {
    metaVersion: version,
    source: spec.source,
    distTag: spec.source === 'latest' || spec.source === 'next' ? spec.source : undefined,
  },
  componentGraph: graph,
  standaloneVerdict,
  completeVerdict,
  verdict: completeVerdict,
  lifecycle: draft.lifecycle,
  doctor,
  dumpConsistency,
  steps,
  dumpContainsClarifyAfterAdd,
  dumpContainsClarifyAfterRemove,
  dumpContainsClarifyAfterReadd,
}
writeEvidence(version, 't1-lifecycle.json', evidence)
writeEvidence(version, 't1-report.md', formatT1Report(evidence, graph))
rmSync(packDir, { recursive: true, force: true })

console.log(`T1 standalone=${standaloneVerdict} complete=${completeVerdict} doctor=${doctor.verdict} dumpConsistency=${dumpConsistency.ok}`)
if (standaloneVerdict !== '通过') process.exitCode = 1

async function bootOnce(dshBin, env) {
  const child = spawnDsh(dshBin, ['--profile', 'web', '--port', '0'], env)
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk.toString() })
  child.stderr.on('data', (chunk) => { output += chunk.toString() })
  let reachable = false
  let diy = false
  let remoteLive = false
  try {
    const waited = await waitForPrintedOrigin(child, () => output, 90_000)
    const clarify = await fetch(new URL('/clarify', waited.origin))
    const text = await clarify.text()
    reachable = clarify.status < 500
    diy = text.includes('window.CLARIFY_REMOTE') && text.includes('/api/') && !text.includes('/clarify/rpc') && !text.includes('session.create')
    const remote = await callClarify(waited.origin, 'start', { sessionId: 'missing-session' })
    remoteLive = remote.json?.type === 'server-response'
  } catch (error) {
    output += `\n[bootOnce] ${error instanceof Error ? error.message : String(error)}`
  } finally {
    await stopChild(child)
  }
  return {
    name: 'boot web after add',
    ok: reachable && diy && remoteLive,
    output: redact(output.slice(0, 4000)),
    diy,
    remoteLive,
  }
}

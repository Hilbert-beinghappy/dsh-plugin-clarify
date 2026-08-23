#!/usr/bin/env node
// t7-lab --validate | --from-pack | --from-release --require-local-assets
// Session seed source=official-public-remote; snapshot beforeFirstClarifyRpc immediately before first Clarify RPC.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildT7Document,
  evaluateTrackedT7,
  formatT7Report,
  isFullT7,
  parseT7LabArgs,
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
  stripProviderKeys,
  takePublicSnapshot,
} from './lib/t7-surfaces.mjs'
import {
  ensureOfficialDsh,
  isolatedHome,
  publicOrigin,
  root,
  runDsh,
  spawnDsh,
  stopChild,
  waitForPrintedOrigin,
} from './lib/harness.mjs'
import { callClarify, postApi } from './lib/remote-client.mjs'

stripProviderKeys(process.env)

const args = parseT7LabArgs(process.argv.slice(2))
const evidenceDir = join(root, 'docs', 't7-evidence', args.dshVersion)
const trackedJson = join(evidenceDir, 't7.json')
const trackedReport = join(evidenceDir, 't7-report.md')

if (args.mode === 'validate') {
  if (!existsSync(trackedJson) || !existsSync(trackedReport)) {
    console.error('T7 validate blocked: tracked t7/1 evidence is missing')
    process.exit(1)
  }
  const doc = JSON.parse(readFileSync(trackedJson, 'utf8'))
  const report = readFileSync(trackedReport, 'utf8')
  const evaluated = evaluateTrackedT7(doc, report)
  if (!evaluated.ok) {
    console.error('T7 validate blocked:', evaluated.errors.join('; '))
    process.exit(1)
  }
  console.log(`T7 validate passed: tracked t7/1 evidence G0=${evaluated.g0Label}; fullT7=${evaluated.fullT7 === true}`)
  process.exit(0)
}

let asset
try {
  asset = resolveT7Assets(args)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
if (args.mode === 'from-release' && !asset.checksumVerified) {
  console.error('阻塞：--from-release 发布资产未通过校验和核验')
  process.exit(1)
}

let observation
try {
  observation = await runHostLab(args, asset)
} catch (error) {
  console.error(`T7 ${args.mode} blocked: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const doc = buildT7Document(observation)
const checked = validateT7Document(doc)
if (!checked.ok) {
  console.error('T7 document invalid:', checked.errors.join('; '))
  process.exit(1)
}
if (isFullT7(doc)) {
  console.error('T7 refused to mark no-key/mock/from-pack as full T7')
  process.exit(1)
}

const report = formatT7Report(doc)
console.log(JSON.stringify(doc, null, 2))
console.log(report)

if (args.write) {
  if (!asset.userValue) {
    console.error('拒绝写入：用户价值 T7 证据只允许 checksum-verified --from-release')
    process.exit(1)
  }
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(trackedJson, `${JSON.stringify(doc, null, 2)}\n`)
  writeFileSync(trackedReport, report)
}

console.log(`T7 ${args.mode} recorded gate=${doc.gate} g0=${doc.g0Verdict} fullT7=${doc.fullT7} origin=${publicOrigin(observation.origin) ?? 'n/a'}`)

async function runHostLab(parsed, resolved) {
  const env = stripProviderKeys({ ...process.env })
  const dshBin = await ensureOfficialDsh(parsed.dshVersion)
  assertExactDshVersion(runDsh(dshBin, ['--version'], env), parsed.dshVersion)
  const home = isolatedHome(parsed.dshVersion, `t7-${parsed.mode}`)
  env.DSH_HOME = home
  const clarifyTgz = parsed.mode === 'from-pack' ? packLocalClarify() : parsed.clarifyTgz
  execFileSync(dshBin, ['plugin', '--profile', 'web', 'add', clarifyTgz], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (parsed.auxiliaryTgz) {
    execFileSync(dshBin, ['plugin', '--profile', 'web', 'add', parsed.auxiliaryTgz], {
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
  }
  const seekTty = observeSeekTtyInstalled(runDsh(dshBin, ['--profile', 'web', '--dump-config'], env))
  const child = spawnDsh(dshBin, ['--profile', 'web', '--port', '0', '--no-open'], env)
  let bootOutput = ''
  child.stdout.on('data', (chunk) => { bootOutput += chunk.toString() })
  child.stderr.on('data', (chunk) => { bootOutput += chunk.toString() })
  try {
    const { origin } = await waitForPrintedOrigin(child, () => bootOutput, 90_000)
    const diy = inspectDiySurface(await fetchText(new URL('/clarify', origin).href))
    const seeded = await seedOfficialPublicSession(postApi, origin, {
      workspacePath: createIsolatedWorkspacePath(home),
      home,
    })
    const preRaw = await takePublicSnapshot(postApi, origin, seeded.sessionId)
    const preCallSnapshot = snapshotImmediateBeforeFirstClarifyRpc(preRaw)
    const started = seeded.sessionId
      ? await callClarify(origin, 'start', { sessionId: seeded.sessionId, seedText: 't7-no-key' })
      : { ok: false, error: { code: 'SESSION_ID_REQUIRED', message: 'official public remotes did not seed a session' } }
    const postCallSnapshot = await takePublicSnapshot(postApi, origin, seeded.sessionId)
    const start = detectStartSignals(started)
    const g0Ready = start.errorCode === 'INFERENCE_UNAVAILABLE'
      && start.providerFailureCode !== 'UNKNOWN'
      && seekTty.proven === true
      && seekTty.installed === false
      && preRaw.sessionCount?.available
      && preRaw.blankTurns?.available
      && preRaw.officialUsage?.available
    return {
      hostVersion: parsed.dshVersion,
      clarifyVersion: '0.2.2',
      gate: 'G0',
      noKey: true,
      mock: false,
      seekTtyInstalled: seekTty.installed === true,
      seekTtyProven: seekTty.proven === true,
      recommendedJointBaseline: false,
      webOnlyComplete: false,
      draftManuallyPasted: false,
      userSent: false,
      pluginAutoSent: false,
      asset: resolved,
      session: seeded.label ?? labelOfficialPublicSession({ createdByThisScript: seeded.seeded === true }),
      preCallSnapshot,
      start,
      postCallSnapshot,
      diy,
      origin,
      note: g0Ready ? undefined : 'G0 blocked unless all public list projections are observed',
    }
  } finally {
    await stopChild(child)
  }
}

function packLocalClarify() {
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'inherit' })
  const packDir = mkdtempSync(join(tmpdir(), 'clarify-t7-pack-'))
  execFileSync('pnpm', ['pack', '--pack-destination', packDir], { cwd: root, stdio: 'inherit' })
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return join(packDir, `${manifest.name}-${manifest.version}.tgz`)
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  return response.text()
}

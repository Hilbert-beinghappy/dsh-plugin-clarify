import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicOrigin, sanitize, sanitizeText } from './sanitize.mjs'
import { parseDshSpec } from './versions.mjs'
import { inspectClarifyDump, summarizeDump } from './dump.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))

export function parseDshVersion(argv, fallback = '0.1.0-rc.6') {
  return parseDshSpec(argv, fallback).version
}

export function probeWorkDir(version) {
  return join(root, '.probe-work', version)
}

export async function ensureOfficialDsh(version) {
  const dir = join(probeWorkDir(version), 'dsh-install')
  mkdirSync(dir, { recursive: true })
  const pkgPath = join(dir, 'package.json')
  const bin = join(dir, 'node_modules', '.bin', 'dsh')
  let existing = {}
  if (existsSync(pkgPath)) {
    try {
      existing = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch {
      existing = {}
    }
  }
  const already = existing.dependencies?.['@deepseek-ai/dsh'] === version && existsSync(bin)
  if (!already) {
    writeFileSync(pkgPath, JSON.stringify({
      name: 'clarify-dsh-install',
      private: true,
      version: '0.0.0',
    }, null, 2))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - '.'\n")
    writeFileSync(join(dir, '.npmrc'), [
      'ignore-workspace-root-check=true',
      'shared-workspace-lockfile=false',
      'strict-dep-builds=false',
    ].join('\n') + '\n')
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    try {
      execFileSync('pnpm', ['add', '--save-exact', `@deepseek-ai/dsh@${version}`], {
        cwd: dir,
        stdio: 'inherit',
        timeout: 300_000,
      })
    } catch (error) {
      if (!existsSync(bin)) throw error
      const observed = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim()
      if (observed !== version) throw error
    }
  }
  if (!existsSync(bin)) {
    throw new Error(`official dsh bin missing after install for ${version}`)
  }
  return bin
}

export function isolatedHome(version, label) {
  const home = join(probeWorkDir(version), 'homes', label)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  return home
}

export function runDsh(dshBin, args, env, options = {}) {
  return execFileSync(dshBin, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: options.timeout ?? 120_000,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd ?? root,
  })
}

export function spawnDsh(dshBin, args, env) {
  const child = spawn(dshBin, args, {
    env: { ...process.env, ...env },
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  return child
}

export async function waitForPrintedOrigin(child, readOutput, timeoutMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`dsh exited ${child.exitCode} before HTTP ready:\n${readOutput()}`)
    }
    const output = readOutput()
    const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/)
    if (match) {
      const origin = match[0]
      try {
        const response = await fetch(origin)
        if (response) return { origin, response }
      } catch {
        // printed URL may appear before listen completes
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('web did not print a loopback URL in stdout/stderr; refusing to probe 3080 or any pre-existing server')
}

export function writeEvidence(version, name, value) {
  const dir = join(root, 'docs', 't0-evidence', version)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const body = typeof value === 'string' ? sanitizeText(value) : `${JSON.stringify(sanitize(value), null, 2)}\n`
  writeFileSync(path, body)
  return path
}

export function helpText(dshBin, env, args = ['--help']) {
  try {
    return runDsh(dshBin, args, env)
  } catch (error) {
    return error.stdout?.toString?.() ?? error.stderr?.toString?.() ?? error.message
  }
}

export function redact(text) {
  return sanitizeText(text)
}

export async function stopChild(child) {
  child.kill('SIGTERM')
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export { inspectClarifyDump, summarizeDump }
export { root, dirname, readFileSync, publicOrigin, parseDshSpec }

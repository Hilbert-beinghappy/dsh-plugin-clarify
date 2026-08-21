#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isForbiddenPackEntry } from './pack-policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarballName = `${manifest.name}-${manifest.version}.tgz`
const dir = mkdtempSync(join(tmpdir(), 'clarify-pack-'))

try {
  execFileSync(process.execPath, [join(root, 'scripts/remove-appledouble.mjs'), '--delete'], {
    cwd: root,
    stdio: 'inherit',
  })
  execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: root, stdio: 'inherit' })
  const tgz = join(dir, tarballName)
  const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
  const entries = listing.trim().split('\n').filter(Boolean)
  const appleDouble = entries.filter((entry) => isForbiddenPackEntry(entry))
  if (appleDouble.length > 0) {
    throw new Error(`packed AppleDouble or Finder metadata:\n${appleDouble.join('\n')}`)
  }
  const allowed = [
    /^package\/package\.json$/,
    /^package\/LICENSE$/,
    /^package\/README\.md$/,
    /^package\/cordis\.patch\.yml$/,
    /^package\/lib\/.+\.js$/,
    /^package\/lib\/.+\.d\.ts$/,
  ]
  const unexpected = entries.filter((entry) => !allowed.some((pattern) => pattern.test(entry)))
  if (unexpected.length > 0) {
    throw new Error(`packed unexpected paths:\n${unexpected.join('\n')}`)
  }
  if (listing.toLowerCase().includes('seektty') || listing.includes('workspace:')) {
    throw new Error('packed tarball contains seektty or workspace: protocol')
  }
  const forbiddenInferenceBypasses = entries.filter((entry) => (
    /(?:acceptance(?:-channel)?|prepared-call-inference)\.(?:js|d\.ts)$/u.test(entry)
  ))
  if (forbiddenInferenceBypasses.length > 0) {
    throw new Error(`packed tarball contains retired inference bypasses:\n${forbiddenInferenceBypasses.join('\n')}`)
  }
  for (const required of [
    'package/lib/auxiliary-runtime-inference.js',
    'package/lib/auxiliary-runtime-inference.d.ts',
  ]) {
    if (!entries.includes(required)) throw new Error(`packed tarball is missing ${required}`)
  }
  const pkgJson = execFileSync('tar', ['-xzf', tgz, '-O', 'package/package.json'], { encoding: 'utf8' })
  if (pkgJson.includes('workspace:') || pkgJson.toLowerCase().includes('seektty')) {
    throw new Error('packed package.json contains seektty or workspace:')
  }
  if (!pkgJson.includes(`"version": "${manifest.version}"`)) {
    throw new Error(`packed package.json is not ${manifest.version}`)
  }
  console.log(`pack-check ok (${entries.length} entries)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

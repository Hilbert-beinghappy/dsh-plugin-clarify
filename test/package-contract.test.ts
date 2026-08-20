import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('published package contract', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name: string
    version: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    files?: string[]
    dsh?: { bundle?: { patch?: string } }
  }

  it('is version 0.1.0 named dsh-plugin-clarify', () => {
    expect(pkg.name).toBe('dsh-plugin-clarify')
    expect(pkg.version).toBe('0.1.0')
  })

  it('declares official dsh.bundle.patch so plugin add can reconcile the layer', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^- insert:/m)
    expect(patch).toMatch(/id: clarify/)
    expect(patch).toMatch(/name: dsh-plugin-clarify/)
    expect(patch).not.toMatch(/workspace:/)
  })

  it('has a strict files allowlist', () => {
    expect(pkg.files).toEqual([
      'lib/**/*.js',
      'lib/**/*.d.ts',
      'cordis.patch.yml',
      'LICENSE',
      'README.md',
    ])
  })

  it('lockfile importers stay the package root and never mention probe-work', () => {
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    expect(lock).not.toMatch(/\.probe-work/)
    expect(lock).not.toMatch(/workspace:/)
    expect(lock.toLowerCase()).not.toMatch(/seektty/)
  })

  it('forbids workspace protocol and seektty references in package.json', () => {
    const raw = readFileSync(join(root, 'package.json'), 'utf8')
    expect(raw.toLowerCase()).not.toMatch(/seektty/)
    expect(raw).not.toMatch(/workspace:/)
    const depBlocks = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.peerDependencies,
      pkg.optionalDependencies,
    ]
    for (const block of depBlocks) {
      for (const [name, spec] of Object.entries(block ?? {})) {
        expect(name.toLowerCase()).not.toContain('seektty')
        expect(spec.startsWith('workspace:')).toBe(false)
      }
    }
  })
})

describe('source persistence guard', () => {
  it('production sources do not persist Session transcript Plan Goal or queue files', () => {
    const srcDir = join(root, 'src')
    const files = readdirSync(srcDir).filter((name) => name.endsWith('.ts'))
    const joined = files.map((name) => readFileSync(join(srcDir, name), 'utf8')).join('\n')
    expect(joined).not.toMatch(/session\.prompt/)
    expect(joined).not.toMatch(/session\.create/)
    expect(joined).not.toMatch(/writeFileSync/)
    expect(joined).not.toMatch(/SeekTTY/i)
    expect(joined).not.toMatch(/\/clarify\/rpc/)
  })
})

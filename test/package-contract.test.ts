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
    exports?: Record<string, unknown>
    files?: string[]
    scripts?: Record<string, string>
    dsh?: { bundle?: { patch?: string } }
  }

  it('is the unreleased 0.2.0 package named dsh-plugin-clarify', () => {
    expect(pkg.name).toBe('dsh-plugin-clarify')
    expect(pkg.version).toBe('0.2.0')
  })

  it('declares official dsh.bundle.patch so plugin add can reconcile the layer', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^- insert:/m)
    expect(patch).toMatch(/id: clarify/)
    expect(patch).toMatch(/name: dsh-plugin-clarify/)
    expect(patch).not.toMatch(/workspace:/)
  })

  it('publishes only the production entrypoint and no inference bypass subpath', () => {
    expect(pkg.exports?.['.']).toEqual({
      types: './lib/index.d.ts',
      default: './lib/index.js',
    })
    expect(pkg.exports).not.toHaveProperty('./acceptance')
    expect(pkg.exports).not.toHaveProperty('./prepared-call-inference')
  })

  it('cleans generated output before compiling so retired bypasses cannot survive', () => {
    expect(pkg.scripts?.build).toBe('node scripts/build.mjs')
    const build = readFileSync(join(root, 'scripts/build.mjs'), 'utf8')
    expect(build).toContain("new URL('../lib/'")
    expect(build).toMatch(/rmSync\(output, \{ recursive: true, force: true \}\)/u)
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

  it('derives probe tarball names from the package manifest version', () => {
    for (const script of ['scripts/t0-run.mjs', 'scripts/t1-lifecycle.mjs']) {
      const source = readFileSync(join(root, script), 'utf8')
      expect(source).toContain('packageManifest.version')
      expect(source).not.toMatch(/dsh-plugin-clarify-\d+\.\d+\.\d+\.tgz/)
    }
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

  it('ships no deterministic semantic questions or stub inference API', () => {
    const srcDir = join(root, 'src')
    const source = readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => readFileSync(join(srcDir, name), 'utf8'))
      .join('\n')
    expect(source).not.toMatch(/StubInferenceEngine|STUB_ASKS|STUB_QUESTIONS|stub-inference/)
    expect(source).not.toContain('What is the main thing you want to accomplish?')
    expect(source).not.toContain('Which constraints should the draft respect?')
  })

  it('keeps direct LLM and acceptance-composer bypasses out of the package', () => {
    const index = readFileSync(join(root, 'src/index.ts'), 'utf8')
    const publicApi = readFileSync(join(root, 'src/public-api.ts'), 'utf8')
    const sourceNames = readdirSync(join(root, 'src'))
    expect(sourceNames).not.toContain('acceptance.ts')
    expect(sourceNames).not.toContain('acceptance-channel.ts')
    expect(sourceNames).not.toContain('prepared-call-inference.ts')
    expect(index).not.toMatch(/acceptance|prepareCall|ctx\.llm/)
    expect(publicApi).not.toMatch(/acceptance|PreparedCall|prepareCall/)
  })
})

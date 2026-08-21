import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isForbiddenPackEntry } from '../scripts/pack-policy.mjs'

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
    dsh?: { bundle?: { patch?: string }; host?: string }
    dshPlugin?: { testedHost?: string; testedHosts?: string[] }
  }

  it('is the unreleased 0.2.2 package named dsh-plugin-clarify', () => {
    expect(pkg.name).toBe('dsh-plugin-clarify')
    expect(pkg.version).toBe('0.2.2')
    expect(pkg.dsh?.host).toBeUndefined()
    expect(pkg.dshPlugin?.testedHost).toBe('0.1.1-rc.2')
    expect(pkg.dshPlugin?.testedHosts).toEqual(['0.1.0-rc.8', '0.1.1-rc.2'])
    expect(pkg.dshPlugin?.testedHosts).not.toContain('0.1.1-rc.1')
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

  it('pins the 0.1.1-rc.2 contract lane, keeps rc.1 historical commands, and keeps pack-policy out of the published files', () => {
    expect(pkg.scripts?.['t0:dsh011rc2']).toBe('node scripts/t0-run.mjs --dsh-version 0.1.1-rc.2')
    expect(pkg.scripts?.['t1:dsh011rc2']).toBe('node scripts/t1-lifecycle.mjs --dsh-version 0.1.1-rc.2')
    expect(pkg.scripts?.['t0:dsh011rc1']).toBe('node scripts/t0-run.mjs --dsh-version 0.1.1-rc.1')
    expect(pkg.scripts?.['t1:dsh011rc1']).toBe('node scripts/t1-lifecycle.mjs --dsh-version 0.1.1-rc.1')
    expect(pkg.scripts).not.toHaveProperty('t0:011')
    expect(pkg.scripts?.['t0:matrix']).toBe('node scripts/t0-matrix.mjs')
    expect(pkg.files?.join('\n')).not.toMatch(/pack-policy|scripts\//)
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toMatch(/node-version: '22'/)
    expect(ci).not.toMatch(/node-version: '24'/)
  })

  it('keeps repository instructions aligned with the unreleased package and contract pins', () => {
    const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(instructions).toContain('当前未发布目标 `0.2.2`')
    expect(instructions).toContain('pinned rc.6 + rc.7 + rc.8 + 0.1.1-rc.2 + 动态 latest')
    expect(instructions).toContain('`0.1.1-rc.1` 只保留为历史复现，不是生产 pin')
    expect(instructions).not.toContain('当前未发布目标 `0.2.1`')
  })

  it('rejects AppleDouble and Finder metadata pack entries without shipping the helper', () => {
    expect(isForbiddenPackEntry('package/lib/._index.js')).toBe(true)
    expect(isForbiddenPackEntry('package/._README.md')).toBe(true)
    expect(isForbiddenPackEntry('package/.DS_Store')).toBe(true)
    expect(isForbiddenPackEntry('package/lib/.DS_Store')).toBe(true)
    expect(isForbiddenPackEntry('package/lib/index.js')).toBe(false)
    expect(isForbiddenPackEntry('package/README.md')).toBe(false)
    const packCheck = readFileSync(join(root, 'scripts/pack-check.mjs'), 'utf8')
    const packPolicy = readFileSync(join(root, 'scripts/pack-policy.mjs'), 'utf8')
    expect(packCheck).toMatch(/isForbiddenPackEntry/)
    expect(packPolicy).toMatch(/segment\.startsWith\('\._'\)/)
    expect(packPolicy).toMatch(/segment === '\.DS_Store'/)
    expect(packPolicy.split('\n').filter((line) => line.trim()).length).toBeLessThan(8)
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

  it('does not publish unused Auxiliary pairing helpers on the public compat surface', () => {
    const publicApi = readFileSync(join(root, 'src/public-api.ts'), 'utf8')
    const compat = readFileSync(join(root, 'src/compat.ts'), 'utf8')
    for (const source of [publicApi, compat]) {
      expect(source).not.toMatch(/productionAuxiliaryMinimum/)
      expect(source).not.toMatch(/isAuxiliaryVersionAtLeast/)
      expect(source).not.toMatch(/isAllowedProductionAuxiliary/)
      expect(source).not.toMatch(/AUXILIARY_MIN_/)
      expect(source).not.toMatch(/PRODUCTION_HOST_VERSIONS/)
    }
    expect(publicApi).toContain('MINIMUM_DSH_VERSION')
    expect(publicApi).toContain('PINNED_CONTRACT_VERSIONS')
    expect(publicApi).not.toMatch(/PINNED_DSH_VERSION(?:_LEGACY_RC8)?/)
    expect(compat).toContain("export const MINIMUM_DSH_VERSION = '0.1.0-rc.6'")
    expect(compat).toContain("export const PINNED_DSH_VERSION = '0.1.1-rc.2'")
    expect(compat).toContain("export const PINNED_DSH_VERSION_LEGACY_RC8 = '0.1.0-rc.8'")
    expect(compat).toContain('PINNED_CONTRACT_VERSIONS')
    expect(compat).not.toMatch(/PINNED_CONTRACT_VERSIONS = \[[^\]]*0\.1\.1-rc\.1/)
  })
})

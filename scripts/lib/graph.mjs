import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_PACKAGES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-token-meter',
]

export function readResolvedGraph(installDir) {
  const metaPath = join(installDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined
  const pnpmDir = join(installDir, 'node_modules', '.pnpm')
  const components = {}
  if (existsSync(pnpmDir)) {
    for (const name of readdirSync(pnpmDir)) {
      if (name.startsWith('._')) continue
      const match = name.match(/^@deepseek-ai\+([^@]+)@([^_]+)/)
      if (!match) continue
      const pkg = `@deepseek-ai/${match[1]}`
      const version = match[2]
      const previous = components[pkg]
      if (!previous) components[pkg] = version
      else if (previous !== version && !String(previous).split(',').includes(version)) {
        components[pkg] = `${previous},${version}`
      }
    }
  }
  const core = {}
  for (const name of CORE_PACKAGES) {
    if (components[name]) core[name] = components[name]
  }
  const coreVersions = [...new Set(Object.values(core))]
  const mixed = coreVersions.length > 1 || (meta?.version && coreVersions.some((item) => item !== meta.version))
  return {
    metaPackage: '@deepseek-ai/dsh',
    metaVersion: meta?.version ?? null,
    declaredBaseRange: meta?.dependencies?.['@deepseek-ai/dsh-base'] ?? null,
    core,
    mixed,
    note: mixed
      ? 'meta package uses caret ranges; resolved components may be newer than the requested meta version. This lane is not a pure single-version tree.'
      : 'resolved core components match the requested meta version',
  }
}

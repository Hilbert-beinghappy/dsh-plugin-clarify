import { execFileSync } from 'node:child_process'

export const MINIMUM_DSH_VERSION = '0.1.0-rc.6'
export const PINNED_DSH_VERSION_LEGACY_RC8 = '0.1.0-rc.8'
export const PINNED_DSH_VERSION = '0.1.1-rc.2'
export const PINNED_CONTRACT_VERSIONS = [
  '0.1.0-rc.6',
  '0.1.0-rc.7',
  PINNED_DSH_VERSION_LEGACY_RC8,
  PINNED_DSH_VERSION,
]

export function uniqueContractVersions({ latest, next, extra = [] } = {}) {
  const versions = new Set(PINNED_CONTRACT_VERSIONS)
  for (const item of extra) {
    if (item) versions.add(item)
  }
  if (latest) versions.add(latest)
  if (next && next !== latest) versions.add(next)
  return [...versions]
}

export function readDistTags() {
  const raw = execFileSync('npm', ['view', '@deepseek-ai/dsh', 'dist-tags', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  const tags = JSON.parse(raw)
  if (!tags || typeof tags !== 'object') {
    throw new Error('npm view @deepseek-ai/dsh dist-tags did not return an object')
  }
  return tags
}

export function resolveTag(tag, tags = readDistTags()) {
  const version = tags[tag]
  if (!version) throw new Error(`@deepseek-ai/dsh dist-tag ${tag} is unpublished`)
  return version
}

export function parseDshSpec(argv, fallback = MINIMUM_DSH_VERSION) {
  const versionIndex = argv.indexOf('--dsh-version')
  if (versionIndex !== -1) return { version: argv[versionIndex + 1] ?? fallback, source: 'version' }
  const tagIndex = argv.indexOf('--dsh-tag')
  if (tagIndex !== -1) {
    const tag = argv[tagIndex + 1]
    if (!tag) throw new Error('--dsh-tag requires latest or next')
    return { version: resolveTag(tag), source: tag, tags: readDistTags() }
  }
  return { version: fallback, source: 'minimum' }
}

export function matrixFromTags(tags) {
  return {
    tags,
    latest: tags.latest,
    next: tags.next,
    versions: uniqueContractVersions({ latest: tags.latest, next: tags.next }),
    snapshot: `latest=${tags.latest ?? 'unpublished'} next=${tags.next ?? 'unpublished'}`,
  }
}

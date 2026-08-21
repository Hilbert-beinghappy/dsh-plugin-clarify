const PRIVATE_PATH = /(?:\/(?:Users|home|var\/folders|private\/var\/folders|Volumes)\/[^\s"'\\]+|(?:file:\/{1,3}(?:\/Users|\/home|\/var\/folders|\/Volumes)[^\s"'\\]+)|[A-Za-z]:\\Users\\[^\s"'\\]+)/g
const STORE_PATH = /(?:Content-addressable store is at:|Virtual store is at:)[^\n]*/g
const LOOPBACK_ORIGIN = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g
const COMMAND_DURATION = /\bDone in \d+(?:\.\d+)?(?:ms|s)\b/g
const CACHE_AGE = /\bverified \d+(?:\.\d+)?(?:ms|s) ago\b/g

export function sanitize(value) {
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, nested] of Object.entries(value)) out[key] = sanitize(nested)
    return out
  }
  return value
}

export function sanitizeText(text) {
  return String(text)
    .replace(/(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=<redacted>')
    .replace(/sk-[A-Za-z0-9]+/g, '<redacted>')
    .replace(/DSH_HOME(?:=|:)\s*\S+/g, 'DSH_HOME=<redacted>')
    .replace(STORE_PATH, '<redacted-store>')
    .replace(PRIVATE_PATH, '<redacted-path>')
    .replace(/file:<redacted-path>/g, 'file:<redacted-path>')
    .replace(LOOPBACK_ORIGIN, (origin) => origin.replace(/:\d+$/, ':<ephemeral>'))
    .replace(COMMAND_DURATION, 'Done in <ephemeral>')
    .replace(CACHE_AGE, 'verified <ephemeral> ago')
}

export function publicOrigin(origin) {
  if (typeof origin !== 'string') return undefined
  const match = origin.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/)
  return match ? origin.replace(/:\d+$/, ':<ephemeral>') : '<redacted-origin>'
}

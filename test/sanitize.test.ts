import { describe, expect, it } from 'vitest'
import { publicOrigin, sanitizeText } from '../scripts/lib/sanitize.mjs'

describe('public evidence sanitizer', () => {
  it('removes local absolute and file: paths', () => {
    const raw = [
      'dependencies:',
      '+ dsh-plugin-clarify file:/var/folders/xd/1qtnjp4s4kv_9z6x7bq465kw0000gn/T/clarify-t0-pack-dfGCOb/dsh-plugin-clarify-0.1.0.tgz',
      'Content-addressable store is at: /Users/huangjiawei/Library/pnpm/store/v11',
    ].join('\n')
    const cleaned = sanitizeText(raw)
    expect(cleaned).not.toMatch(/\/Users\//)
    expect(cleaned).not.toMatch(/\/var\/folders\//)
    expect(cleaned).toContain('<redacted-path>')
    expect(cleaned).toContain('<redacted-store>')
  })

  it('redacts DSH_HOME assignments', () => {
    expect(sanitizeText('DSH_HOME=/Volumes/huawei/secret-home')).toBe('DSH_HOME=<redacted>')
  })

  it('publishes only loopback origin shape', () => {
    expect(publicOrigin('http://127.0.0.1:60358')).toBe('http://127.0.0.1:<ephemeral>')
    expect(publicOrigin('https://example.internal')).toBe('<redacted-origin>')
  })
})

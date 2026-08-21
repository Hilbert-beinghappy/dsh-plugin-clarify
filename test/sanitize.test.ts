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

  it('normalizes volatile lifecycle evidence', () => {
    const cleaned = sanitizeText([
      'dsh web: http://127.0.0.1:51138',
      'Done in 382ms using pnpm v11.19.0',
      'Lockfile passes supply-chain policies (verified 2s ago)',
    ].join('\n'))
    expect(cleaned).toContain('http://127.0.0.1:<ephemeral>')
    expect(cleaned).toContain('Done in <ephemeral> using pnpm v11.19.0')
    expect(cleaned).toContain('verified <ephemeral> ago')
    expect(cleaned).not.toMatch(/51138|382ms|verified 2s/)
  })

  it('normalizes timestamps and RPC ids in captured payloads', () => {
    expect(sanitizeText('{"capturedAt":"2026-08-21T01:44:54.944Z","rpcId":"1b835a62-8f54-4406-80db-28f6160752ee","webServerPort":59403}'))
      .toBe('{"capturedAt":"<ephemeral-timestamp>","rpcId":"<ephemeral-uuid>","webServerPort":"<ephemeral>"}')
  })

  it('publishes only loopback origin shape', () => {
    expect(publicOrigin('http://127.0.0.1:60358')).toBe('http://127.0.0.1:<ephemeral>')
    expect(publicOrigin('https://example.internal')).toBe('<redacted-origin>')
  })
})

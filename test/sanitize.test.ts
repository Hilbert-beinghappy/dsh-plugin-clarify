import { describe, expect, it } from 'vitest'
import { publicOrigin, sanitizeT7, sanitizeText } from '../scripts/lib/sanitize.mjs'

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

  it('strips T7 tracked secrets instead of leaving raw usage or session payload', () => {
    const cleaned = sanitizeT7({
      sessionId: 'sess-live-1',
      seedText: 'need a draft about logout',
      answer: 'pick the safest option',
      draft: 'Please implement logout.',
      refineFeedback: 'shorter',
      provider: 'openai',
      model: 'secret-model',
      path: '/Users/huangjiawei/.dsh/profile.json',
      credential: 'sk-live-secret',
      apiKey: 'sk-abc',
      profile: { name: 'tui' },
      totalTokens: 41,
      uncachedInputTokens: 12,
      outputTokens: 29,
      gate: 'G0',
      officialUsageBand: 'zero',
    })
    expect(cleaned).not.toHaveProperty('sessionId')
    expect(cleaned).not.toHaveProperty('seedText')
    expect(cleaned).not.toHaveProperty('answer')
    expect(cleaned).not.toHaveProperty('draft')
    expect(cleaned).not.toHaveProperty('refineFeedback')
    expect(cleaned).not.toHaveProperty('provider')
    expect(cleaned).not.toHaveProperty('model')
    expect(cleaned).not.toHaveProperty('path')
    expect(cleaned).not.toHaveProperty('credential')
    expect(cleaned).not.toHaveProperty('apiKey')
    expect(cleaned).not.toHaveProperty('profile')
    expect(cleaned).not.toHaveProperty('totalTokens')
    expect(cleaned).not.toHaveProperty('uncachedInputTokens')
    expect(cleaned).not.toHaveProperty('outputTokens')
    expect(cleaned.gate).toBe('G0')
    expect(cleaned.officialUsageBand).toBe('zero')
    expect(JSON.stringify(cleaned)).not.toMatch(/sess-live-1|logout|openai|sk-live-secret|41/)
    expect(sanitizeT7({
      diyJourney: { methods: { answer: 'succeeded', refine: 'succeeded' } },
    })).toEqual({
      diyJourney: { methods: { answer: 'succeeded', refine: 'succeeded' } },
    })
    expect(sanitizeT7({
      diy: { methods: { answer: true, refine: true } },
    })).toEqual({
      diy: { methods: { answer: true, refine: true } },
    })
    expect(sanitizeT7({
      start: { message: 'auxiliary model call did not succeed (ENOTSUP)' },
      html: '<!doctype html>',
      dump: '# == seektty',
      diy: { methods: { refine: 'please leak the draft' } },
    })).toEqual({
      start: {},
      diy: { methods: {} },
    })
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { classifyLaneSpawn, formatLaneSpawnFailure } from '../scripts/lib/matrix-lane.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('matrix lane spawn classification', () => {
  it('treats only ETIMEDOUT as timeout/124 even when Node also reports SIGTERM', () => {
    const classified = classifyLaneSpawn({
      error: { code: 'ETIMEDOUT' },
      signal: 'SIGTERM',
      status: null,
    })
    expect(classified).toEqual({
      timedOut: true,
      exit: 124,
      signal: 'SIGTERM',
      label: 'TIMEOUT',
    })
    const message = formatLaneSpawnFailure('t0-run.mjs', '0.1.1-rc.1', classified)
    expect(message).toBe('TIMEOUT t0-run.mjs 0.1.1-rc.1 exit 124')
    expect(message).toContain('TIMEOUT')
    expect(message).not.toMatch(/900000/)
  })

  it('records ordinary SIGTERM as BLOCK/FAIL with the real signal, not timeout', () => {
    const classified = classifyLaneSpawn({
      signal: 'SIGTERM',
      status: null,
    })
    expect(classified.timedOut).toBe(false)
    expect(classified.exit).toBe(1)
    expect(classified.signal).toBe('SIGTERM')
    expect(classified.label).toBe('BLOCK/FAIL')
    const message = formatLaneSpawnFailure('t0-run.mjs', '0.1.0-rc.8', classified)
    expect(message).toBe('BLOCK/FAIL t0-run.mjs 0.1.0-rc.8 exit 1 signal SIGTERM')
    expect(message).not.toContain('TIMEOUT')
    expect(message).not.toMatch(/900000/)
  })

  it('records ordinary SIGKILL as BLOCK/FAIL with the real signal, not timeout', () => {
    const classified = classifyLaneSpawn({
      signal: 'SIGKILL',
      status: null,
    })
    expect(classified.timedOut).toBe(false)
    expect(classified.signal).toBe('SIGKILL')
    expect(classified.label).toBe('BLOCK/FAIL')
    const message = formatLaneSpawnFailure('t1-lifecycle.mjs', '0.1.1-rc.1', classified)
    expect(message).toBe('BLOCK/FAIL t1-lifecycle.mjs 0.1.1-rc.1 exit 1 signal SIGKILL')
    expect(message).not.toContain('TIMEOUT')
    expect(message).not.toMatch(/900000/)
  })

  it('keeps a nonzero status as BLOCK/FAIL without a signal suffix', () => {
    const classified = classifyLaneSpawn({ status: 1 })
    expect(classified).toEqual({
      timedOut: false,
      exit: 1,
      signal: null,
      label: 'BLOCK/FAIL',
    })
    expect(formatLaneSpawnFailure('t0-run.mjs', '0.1.0-rc.6', classified))
      .toBe('BLOCK/FAIL t0-run.mjs 0.1.0-rc.6 exit 1')
  })

  it('treats status 0 without ETIMEDOUT as success', () => {
    const classified = classifyLaneSpawn({ status: 0, signal: null })
    expect(classified).toEqual({
      timedOut: false,
      exit: 0,
      signal: null,
      label: 'OK',
    })
  })
})

describe('matrix lane helper stays a local script, not a published file', () => {
  it('is imported by t0-matrix and is outside the published files allowlist', () => {
    const matrix = readFileSync(join(root, 'scripts/t0-matrix.mjs'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files?: string[] }
    expect(matrix).toContain("from './lib/matrix-lane.mjs'")
    expect(matrix).toContain('classifyLaneSpawn')
    expect(matrix).toContain('formatLaneSpawnFailure')
    expect(matrix).not.toMatch(/result\.signal === 'SIGTERM'/)
    expect(matrix).not.toMatch(/after \$\{LANE_TIMEOUT_MS\}ms/)
    expect(pkg.files?.join('\n')).not.toMatch(/matrix-lane|scripts\//)
  })
})

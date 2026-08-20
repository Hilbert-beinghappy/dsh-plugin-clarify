import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gateTable, isBusinessRemoteArrival, isInfrastructureRemoteFailure, verdictA, verdictB, verdictC, verdictD } from '../scripts/lib/verdicts.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('T0 verdicts follow evidence only', () => {
  const probe = JSON.parse(readFileSync(join(root, 'docs/t0-evidence/0.1.0-rc.6/probe.json'), 'utf8')) as {
    usage: Record<string, unknown>
    header: Record<string, unknown>
    web: Record<string, unknown>
  }

  it('marks (a) feasible when off-transcript stream succeeded with zero deltas', () => {
    const result = verdictA(probe.usage, { httpProbe: probe })
    expect(result.status).toBe('可行')
    expect(probe.usage.offTranscript).toBe(true)
    expect(probe.usage.eventCountDelta).toBe(0)
    expect(probe.usage.derivedDelta).toBe(0)
  })

  it('keeps (b) blocked when live system/tools change is unobserved', () => {
    expect(verdictB(probe.header).status).toBe('阻塞')
  })

  it('keeps (d) blocked when usage projection does not change', () => {
    expect(verdictD(probe.usage).status).toBe('阻塞')
    expect(JSON.stringify(probe.usage.usageMeasureBefore)).toBe(JSON.stringify(probe.usage.usageMeasureAfter))
  })

  it('keeps (d) blocked when measure changes only on a probe-created session', () => {
    expect(verdictD({
      status: 'observed',
      probeCreatedSession: true,
      sessionSource: 'created-by-probe',
      usageMeasureBefore: { totalTokens: 0 },
      usageMeasureAfter: { totalTokens: 4 },
    }).status).toBe('阻塞')
  })

  it('does not treat a homemade HTTP DIY page as Remote discovery', () => {
    const gates = gateTable({
      ...probe,
      web: { ...probe.web, clarifyRemoteClaimed: false, consumerPath: { status: 'blocked' }, hasTypertGatewayInvoke: false },
    }, {
      http: { clarify: { diy: true } },
      remoteLive: false,
    })
    expect(gates.c.status).toBe('阻塞')
  })

  it('marks (c) blocked when Gateway only reports invocation-unavailable', () => {
    const result = verdictC({
      clarifyRemoteClaimed: false,
      typertLocalEndpoints: ['commands/execute'],
      hasTypertGatewayInvoke: true,
      consumerPath: {
        status: 'observed',
        observed: 4,
        endpoints: {
          start: { status: 'observed', kind: 'infrastructure', error: 'typert gateway: clarify/start: no active Remote method exports this endpoint' },
          answer: { status: 'observed', kind: 'infrastructure', error: 'typert gateway: clarify/answer: no active Remote method exports this endpoint' },
          cancel: { status: 'observed', kind: 'infrastructure', error: 'typert gateway: clarify/cancel: no active Remote method exports this endpoint' },
          fetchDraft: { status: 'observed', kind: 'infrastructure', error: 'typert gateway: clarify/fetchDraft: no active Remote method exports this endpoint' },
        },
      },
    }, {
      http: { clarify: { diy: true }, remote: { status: 404, live: false } },
      remoteLive: false,
      httpRemote: { status: 404, json: { type: undefined } },
    })
    expect(result.status).toBe('阻塞')
    expect(result.reason).toMatch(/typert\.local/)
  })

  it('marks (c) feasible only when local claim and business arrival coexist', () => {
    expect(verdictC({
      clarifyRemoteClaimed: true,
      typertLocalEndpoints: ['clarify/start', 'clarify/answer', 'clarify/cancel', 'clarify/fetchDraft'],
      consumerPath: {
        endpoints: {
          start: { status: 'hit', kind: 'business', code: 'PROCESS_NOT_FOUND' },
          answer: { status: 'hit', kind: 'business', code: 'PROCESS_NOT_FOUND' },
          cancel: { status: 'hit', kind: 'business', code: 'PROCESS_NOT_FOUND' },
          fetchDraft: { status: 'hit', kind: 'business', code: 'PROCESS_NOT_FOUND' },
        },
      },
    }).status).toBe('可行')
  })

  it('treats remapped Host internal errors as business only when the message is Clarify-owned', () => {
    expect(isInfrastructureRemoteFailure({ httpStatus: 404, message: 'not found' })).toBe(true)
    expect(isInfrastructureRemoteFailure({ code: 'invocation-unavailable', message: 'no active Remote method exports this endpoint' })).toBe(true)
    expect(isBusinessRemoteArrival({ code: 'internal', message: 'process missing-process does not exist' })).toBe(true)
    expect(isBusinessRemoteArrival({ code: 'internal', message: 'no active Remote method exports this endpoint' })).toBe(false)
  })

  it('marks (c) blocked when official HTTP is 404 even if DIY exists', () => {
    const result = verdictC({
      clarifyRemoteClaimed: false,
      typertLocalEndpoints: ['commands/execute', 'goals/create'],
      consumerPath: {
        status: 'observed',
        observed: 4,
        endpoints: {
          start: { status: 'blocked', kind: 'infrastructure' },
          answer: { status: 'blocked', kind: 'infrastructure' },
          cancel: { status: 'blocked', kind: 'infrastructure' },
          fetchDraft: { status: 'blocked', kind: 'infrastructure' },
        },
      },
    }, {
      httpRemote: { status: 404, textPreview: 'not found' },
      http: { hostT3: { ok: false, endpoints: { start: { status: 404 } } } },
    })
    expect(result.status).toBe('阻塞')
    expect(result.reason).toMatch(/基础设施/)
  })
})

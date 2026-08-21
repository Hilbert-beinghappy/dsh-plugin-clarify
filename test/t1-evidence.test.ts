import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DUMP_ABSENT, dumpEvidenceContradictions, inspectClarifyDump, summarizeDump } from '../scripts/lib/dump.mjs'
import { labelHostT3Session } from '../scripts/lib/remote-client.mjs'
import {
  t1CompleteVerdict,
  t1DoctorVerdict,
  t1LifecycleVerdict,
  t1StandaloneExitOk,
  t1StandaloneVerdict,
  t1Verdict,
} from '../scripts/lib/matrix-row.mjs'
import { sanitize } from '../scripts/lib/sanitize.mjs'
import { pendingCrossProjectDoctor } from '../scripts/lib/t1-verdicts.mjs'
import { PINNED_CONTRACT_VERSIONS } from '../scripts/lib/versions.mjs'

function officialThenClarifyDump() {
  return `# == @deepseek-ai/dsh-base\n${'x'.repeat(4500)}\n# == dsh-plugin-clarify\n  name: dsh-plugin-clarify\n`
}

describe('T1 dump summaries use the full raw dump', () => {
  it('does not claim absent when clarify sits after the first 4000 chars', () => {
    const dump = officialThenClarifyDump()
    expect(summarizeDump(dump.slice(0, 4000))).toBe(DUMP_ABSENT)
    const inspected = inspectClarifyDump(dump)
    expect(inspected.present).toBe(true)
    expect(inspected.excerpt).toContain('# == dsh-plugin-clarify')
    expect(inspected.excerpt).not.toMatch(/not found/)
    expect(dumpEvidenceContradictions([{
      label: 'after add',
      raw: dump,
      present: inspected.present,
      excerpt: inspected.excerpt,
    }])).toEqual([])
  })

  it('keeps remove dumps absent consistently', () => {
    const dump = `# == @deepseek-ai/dsh-base\n${'y'.repeat(100)}\n`
    const inspected = inspectClarifyDump(dump)
    expect(inspected.present).toBe(false)
    expect(inspected.excerpt).toBe(DUMP_ABSENT)
    expect(dumpEvidenceContradictions([{
      label: 'after remove',
      raw: dump,
      present: false,
      excerpt: DUMP_ABSENT,
    }])).toEqual([])
  })

  it('fails the T1 assertion when boolean and text disagree', () => {
    const dump = officialThenClarifyDump()
    const errors = dumpEvidenceContradictions([{
      label: 'dump-config after add',
      raw: dump,
      present: true,
      excerpt: DUMP_ABSENT,
    }])
    expect(errors.some((item) => item.includes('present=true but excerpt says not found'))).toBe(true)
    expect(errors.some((item) => item.includes('does not match full-dump summary'))).toBe(true)
  })
})

describe('T1 doctor is cross-project, not stock dsh', () => {
  it('does not keep the deleted stock CLI/HTTP doctor probe', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    expect(existsSync(join(root, 'scripts/lib/doctor.mjs'))).toBe(false)
    const t1 = readFileSync(join(root, 'scripts/t1-lifecycle.mjs'), 'utf8')
    const t0 = readFileSync(join(root, 'scripts/t0-run.mjs'), 'utf8')
    expect(t1).not.toMatch(/probeDoctorHttp|listedDoctorCommand|classifyDoctor/)
    expect(t0).not.toMatch(/probeDoctorHttp|listedDoctorCommand|classifyDoctor/)
    expect(t1).not.toMatch(/new URL\('\/doctor'/)
    expect(t0).not.toMatch(/new URL\('\/doctor'/)
  })

  it('treats missing stock doctor as 待联调, not standalone or complete 通过', () => {
    const pending = pendingCrossProjectDoctor()
    expect(pending.verdict).toBe('待联调')
    expect(pending.stockCli).toBe(false)
    expect(pending.stockHttp).toBe(false)
    expect(pending.invented).toBe(false)
    expect(pending.surface).toBe('tui-local-/doctor')
    expect(sanitize(pending).surface).toBe(pending.surface)
    expect(sanitize(pending).surface).not.toContain('<redacted>')
    const t1 = {
      lifecycle: { verdict: '通过', failed: [] },
      dumpConsistency: { ok: true },
      doctor: pending,
      steps: [{ name: 'plugin add', ok: true }],
    }
    expect(t1StandaloneVerdict(t1)).toBe('通过')
    expect(t1DoctorVerdict(t1)).toBe('待联调')
    expect(t1CompleteVerdict(t1)).toBe('未完成')
    expect(t1Verdict(t1)).not.toBe('通过')
    expect(t1StandaloneExitOk(t1)).toBe(true)
  })

  it('reinterprets old stock CLI/HTTP doctor 阻塞 as 待联调', () => {
    const t1 = {
      verdict: '阻塞',
      lifecycle: { verdict: '通过', failed: [] },
      dumpConsistency: { ok: true },
      doctor: {
        verdict: '阻塞',
        cli: { discoverable: false, ran: false },
        http: { officialSignature: false, status: 200 },
        slash: { interpretation: 'stock GET /doctor' },
      },
      steps: [
        { name: 'plugin add', ok: true },
        { name: 'doctor', ok: false, output: 'dsh --help 未列出 doctor' },
      ],
    }
    expect(t1LifecycleVerdict(t1)).toBe('通过')
    expect(t1DoctorVerdict(t1)).toBe('待联调')
    expect(t1CompleteVerdict(t1)).toBe('未完成')
    expect(t1StandaloneExitOk(t1)).toBe(true)
  })
})

describe('Host T3 session fixture labels', () => {
  it('labels a probe-created then listed session as t0-probe-test-fixture', () => {
    const labeled = labelHostT3Session(
      { sessionId: 'sess-1', method: 'session.list', created: false },
      { probeCreatedSession: true, sessionSource: 'created-by-probe' },
    )
    expect(labeled.source).toBe('t0-probe-test-fixture')
    expect(labeled.createdByHarness).toBe(true)
    expect(labeled.productionPluginCreated).toBe(false)
    expect(labeled.createdByThisScript).toBe(false)
  })
})

describe('checked-in T1 evidence stays internally consistent', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))

  it('accepts 0.1.1-rc.2 as the fourth pinned evidence lane without fabricating files', () => {
    expect([...PINNED_CONTRACT_VERSIONS]).toEqual(['0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8', '0.1.1-rc.2'])
    expect(PINNED_CONTRACT_VERSIONS).not.toContain('0.1.1-rc.1')
  })

  it('keeps the same-day replaced 0.1.1-rc.1 evidence directory as historical, not a production pin', () => {
    expect(existsSync(join(root, 'docs/t0-evidence/0.1.1-rc.1/t0-blocking-report.md'))).toBe(true)
    expect(existsSync(join(root, 'docs/t0-evidence/0.1.1-rc.1/t1-report.md'))).toBe(true)
    expect(PINNED_CONTRACT_VERSIONS).not.toContain('0.1.1-rc.1')
  })

  for (const version of PINNED_CONTRACT_VERSIONS) {
    const evidencePath = join(root, 'docs/t0-evidence', version, 't1-lifecycle.json')
    it(`${version} dump flags match excerpts; standalone 通过; doctor 待联调; T1 未完全通过`, () => {
      expect(existsSync(evidencePath)).toBe(true)
      const t1 = JSON.parse(readFileSync(join(root, 'docs/t0-evidence', version, 't1-lifecycle.json'), 'utf8')) as {
        verdict: string
        standaloneVerdict?: string
        completeVerdict?: string
        dumpContainsClarifyAfterAdd: boolean
        dumpContainsClarifyAfterRemove: boolean
        dumpContainsClarifyAfterReadd: boolean
        dumpConsistency: { ok: boolean }
        doctor: { verdict: string, cli?: unknown, http?: unknown }
        steps: Array<{ name: string, output?: string }>
      }
      const add = t1.steps.find((item) => item.name === 'dump-config after add')
      const remove = t1.steps.find((item) => item.name === 'dump-config after remove')
      const readd = t1.steps.find((item) => item.name === 'dump-config after re-add')
      expect(t1.dumpContainsClarifyAfterAdd).toBe(true)
      expect(add?.output).toContain('# == dsh-plugin-clarify')
      expect(add?.output).not.toMatch(/not found/)
      expect(t1.dumpContainsClarifyAfterRemove).toBe(false)
      expect(remove?.output).toBe(DUMP_ABSENT)
      expect(t1.dumpContainsClarifyAfterReadd).toBe(true)
      expect(readd?.output).toContain('# == dsh-plugin-clarify')
      expect(t1.dumpConsistency.ok).toBe(true)
      expect(t1.steps.some((item) => item.name === 'doctor')).toBe(false)
      expect(t1.doctor.cli).toBeUndefined()
      expect(t1.doctor.http).toBeUndefined()
      expect(t1DoctorVerdict(t1)).toBe('待联调')
      expect(t1StandaloneVerdict(t1)).toBe('通过')
      expect(t1CompleteVerdict(t1)).toBe('未完成')
      expect(t1.verdict).not.toBe('通过')
    })
  }
})

describe('checked-in Host T3 provenance', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  for (const version of PINNED_CONTRACT_VERSIONS) {
    const evidencePath = join(root, 'docs/t0-evidence', version, 'host-t3.json')
    it(`${version} host-t3 session is an isolation fixture`, () => {
      expect(existsSync(evidencePath)).toBe(true)
      const hostT3 = JSON.parse(readFileSync(join(root, 'docs/t0-evidence', version, 'host-t3.json'), 'utf8')) as {
        sessionDiscovery: {
          source: string
          createdByHarness: boolean
          productionPluginCreated: boolean
        }
      }
      expect(hostT3.sessionDiscovery.source).toMatch(/test-fixture|isolated-home/)
      expect(hostT3.sessionDiscovery.createdByHarness).toBe(true)
      expect(hostT3.sessionDiscovery.productionPluginCreated).toBe(false)
    })
  }
})

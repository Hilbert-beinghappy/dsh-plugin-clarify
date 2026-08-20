import { describe, expect, it } from 'vitest'
import { collectProbeEvidence, peekService } from '../src/probe.ts'

describe('T0 probe safety', () => {
  it('does not throw when undeclared Cordis services throw on access', async () => {
    const ctx = new Proxy({
      webServer: { register() {} },
    }, {
      get(target, prop, receiver) {
        if (prop === 'remote' || prop === 'credentials' || prop === 'connection') {
          throw new Error(`waiting for service: ${String(prop)}`)
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const evidence = await collectProbeEvidence(ctx)
    expect(evidence.capturedAt).toBeTruthy()
    expect(evidence.usage).toBeTruthy()
    expect(evidence.header).toBeTruthy()
    expect(evidence.web).toBeTruthy()
    expect((evidence.web as { hasRemoteMount?: boolean }).hasRemoteMount).toBe(false)
  })

  it('peekService records the throw instead of propagating it', () => {
    const ctx = new Proxy({}, {
      get() {
        throw new Error('waiting for service: remote')
      },
    })
    expect(peekService(ctx, 'remote')).toEqual({
      present: false,
      error: 'waiting for service: remote',
    })
  })
})

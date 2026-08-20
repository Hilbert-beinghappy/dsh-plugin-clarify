import { describe, expect, it } from 'vitest'
import { contextVersionFromModelVisible, modelRouteIdFromConfig } from '../src/fingerprints.ts'

describe('fingerprints', () => {
  it('hashes provider/model/reasoningEffort as modelRouteId', () => {
    const a = modelRouteIdFromConfig({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    const b = modelRouteIdFromConfig({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
    })
    const c = modelRouteIdFromConfig({
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningEffort: 'low',
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^sha256:/)
  })

  it('changes contextVersion when system or tools change without new messages', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const base = contextVersionFromModelVisible({
      system: 'sys-a',
      tools: [{ name: 'bash', parameters: {} }],
      messages,
    })
    const systemChanged = contextVersionFromModelVisible({
      system: 'sys-b',
      tools: [{ name: 'bash', parameters: {} }],
      messages,
    })
    const toolsChanged = contextVersionFromModelVisible({
      system: 'sys-a',
      tools: [{ name: 'web', parameters: {} }],
      messages,
    })
    expect(base).not.toBe(systemChanged)
    expect(base).not.toBe(toolsChanged)
    expect(base).toBe(contextVersionFromModelVisible({
      system: 'sys-a',
      tools: [{ name: 'bash', parameters: {} }],
      messages,
    }))
  })

  it('does not use a numeric session.seq as contextVersion', () => {
    const hashed = contextVersionFromModelVisible({
      system: 's',
      tools: [],
      messages: [],
    })
    expect(hashed).not.toBe('0')
    expect(hashed).not.toMatch(/^[0-9]+$/)
    expect(hashed).toMatch(/^sha256:/)
  })
})

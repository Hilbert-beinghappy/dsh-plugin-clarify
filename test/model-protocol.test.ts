import { describe, expect, it } from 'vitest'
import {
  assertModelInference,
  decideSameRouteRepair,
  isMaterialPreviewChange,
  parseModelInferenceJson,
  withBoundedSameRouteRepair,
} from '../src/model-protocol.ts'

const ask = {
  kind: 'ask',
  question: 'What should we ship first?',
  options: ['A plugin', 'A patch'],
  multiple: false,
  allowCustom: true,
  draftPreview: 'Ship a clarify plugin.',
  materialChanges: ['named the first deliverable'],
} as const

const awaitAccept = {
  kind: 'await_accept',
  draftPreview: 'Ship a clarify plugin with preview/accept.',
  materialChanges: ['closed the remaining unknowns'],
} as const

describe('strict model inference JSON parser', () => {
  it('accepts the ask union member and rejects additional properties', () => {
    expect(parseModelInferenceJson(JSON.stringify(ask))).toEqual(ask)
    expect(() => parseModelInferenceJson(JSON.stringify({ ...ask, questionId: 'q-model' }))).toThrow(/additional/i)
    expect(() => parseModelInferenceJson(JSON.stringify({ ...ask, optionId: 'o-model' }))).toThrow(/additional/i)
  })

  it('accepts the await_accept union member and rejects mixed or unknown kinds', () => {
    expect(parseModelInferenceJson(JSON.stringify(awaitAccept))).toEqual(awaitAccept)
    expect(() => parseModelInferenceJson(JSON.stringify({
      ...awaitAccept,
      question: 'late question',
      options: ['no'],
      multiple: false,
      allowCustom: false,
    }))).toThrow(/additional/i)
    expect(() => parseModelInferenceJson(JSON.stringify({
      kind: 'draft',
      draftPreview: 'x',
      materialChanges: ['y'],
    }))).toThrow(/kind/)
  })

  it('rejects non-objects, missing required fields, and empty texts', () => {
    expect(() => parseModelInferenceJson('[]')).toThrow()
    expect(() => parseModelInferenceJson('"ask"')).toThrow()
    expect(() => parseModelInferenceJson(JSON.stringify({ ...ask, question: '   ' }))).toThrow()
    expect(() => parseModelInferenceJson(JSON.stringify({ ...ask, options: ['ok', ''] }))).toThrow()
    expect(() => parseModelInferenceJson(JSON.stringify({ ...ask, options: ['dup', 'dup'] }))).toThrow()
    expect(() => parseModelInferenceJson(JSON.stringify({ ...awaitAccept, materialChanges: [] }))).toThrow()
    expect(() => parseModelInferenceJson(JSON.stringify({
      kind: 'ask',
      question: 'Q',
      options: ['A'],
      multiple: false,
      allowCustom: true,
      draftPreview: 'preview',
    }))).toThrow(/materialChanges/)
  })

  it('rejects additional properties on a parsed object via the shared assert', () => {
    const extra = { ...ask, previewVersion: 'v-model' }
    expect(() => assertModelInference(extra)).toThrow(/additional/i)
    expect(assertModelInference({ ...ask })).toEqual(ask)
  })
})

describe('material preview delta', () => {
  it('treats punctuation and word-order-only edits as non-material', () => {
    expect(isMaterialPreviewChange('Hello, world!', 'world hello')).toBe(false)
    expect(isMaterialPreviewChange('Ship the plugin now.', 'Now ship the plugin')).toBe(false)
    expect(isMaterialPreviewChange(undefined, 'first preview')).toBe(true)
    expect(isMaterialPreviewChange('Ship a plugin.', 'Ship a plugin and keep Host IDs off the model.')).toBe(true)
  })
})

describe('bounded same-route one-repair wrapper', () => {
  it('uses a valid payload without calling repair', async () => {
    const raw = JSON.stringify(ask)
    const decision = decideSameRouteRepair(raw)
    expect(decision).toEqual({ decision: 'use', value: ask })
    let repaired = 0
    const value = await withBoundedSameRouteRepair({
      routeId: 'route-v1',
      raw,
      parse: parseModelInferenceJson,
      repair: async () => {
        repaired += 1
        return raw
      },
    })
    expect(value).toEqual(ask)
    expect(repaired).toBe(0)
  })

  it('allows one same-route repair and never a second', async () => {
    const broken = '{"kind":"ask"'
    const decision = decideSameRouteRepair(broken)
    expect(decision.decision).toBe('repair')
    const routes: string[] = []
    const value = await withBoundedSameRouteRepair({
      routeId: 'route-v1',
      raw: broken,
      parse: parseModelInferenceJson,
      repair: async ({ routeId, raw }) => {
        routes.push(routeId)
        expect(raw).toBe(broken)
        return JSON.stringify(awaitAccept)
      },
    })
    expect(value).toEqual(awaitAccept)
    expect(routes).toEqual(['route-v1'])
  })

  it('does not retry after the single repair still fails', async () => {
    let calls = 0
    await expect(withBoundedSameRouteRepair({
      routeId: 'route-v1',
      raw: '{',
      parse: parseModelInferenceJson,
      repair: async ({ routeId }) => {
        calls += 1
        expect(routeId).toBe('route-v1')
        return '{"kind":"ask","extra":true}'
      },
    })).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

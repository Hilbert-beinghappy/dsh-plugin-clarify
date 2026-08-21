import { ClarifyError, type ModelAsk, type ModelAwaitAccept, type ModelInference } from './types.ts'

const ASK_KEYS = ['kind', 'question', 'options', 'multiple', 'allowCustom', 'draftPreview', 'materialChanges'] as const
const AWAIT_KEYS = ['kind', 'draftPreview', 'materialChanges'] as const

export class ModelParseError extends Error {
  readonly repairable: boolean

  constructor(message: string, repairable = true) {
    super(message)
    this.name = 'ModelParseError'
    this.repairable = repairable
  }
}

export function parseModelInferenceJson(raw: string): ModelInference {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON'
    throw new ModelParseError(`model output is not valid JSON: ${message}`)
  }
  return assertModelInference(parsed)
}

export function assertModelInference(value: unknown): ModelInference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelParseError('model output must be a JSON object')
  }
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind === 'ask') {
    rejectAdditionalProperties(record, ASK_KEYS)
    return cloneAsk({
      kind: 'ask',
      question: requiredText(record.question, 'question'),
      options: requiredUniqueTexts(record.options, 'options'),
      multiple: requiredBoolean(record.multiple, 'multiple'),
      allowCustom: requiredBoolean(record.allowCustom, 'allowCustom'),
      draftPreview: requiredText(record.draftPreview, 'draftPreview'),
      materialChanges: requiredUniqueTexts(record.materialChanges, 'materialChanges'),
    })
  }
  if (kind === 'await_accept') {
    rejectAdditionalProperties(record, AWAIT_KEYS)
    return cloneAwait({
      kind: 'await_accept',
      draftPreview: requiredText(record.draftPreview, 'draftPreview'),
      materialChanges: requiredUniqueTexts(record.materialChanges, 'materialChanges'),
    })
  }
  throw new ModelParseError(`model output kind must be ask or await_accept`)
}

export function isMaterialPreviewChange(previous: string | undefined, next: string): boolean {
  if (previous === undefined) return true
  return normalizePreview(previous) !== normalizePreview(next)
}

export type SameRouteRepairDecision =
  | { decision: 'use'; value: ModelInference }
  | { decision: 'repair'; reason: string }
  | { decision: 'reject'; reason: string }

export function decideSameRouteRepair(raw: unknown): SameRouteRepairDecision {
  if (typeof raw !== 'string') {
    return { decision: 'reject', reason: 'raw model output must be a string' }
  }
  try {
    return { decision: 'use', value: parseModelInferenceJson(raw) }
  } catch (error) {
    return {
      decision: 'repair',
      reason: error instanceof Error ? error.message : 'parse failed',
    }
  }
}

export async function withBoundedSameRouteRepair<T>(options: {
  routeId: string
  raw: string
  parse: (raw: string) => T
  repair: (input: { routeId: string; raw: string; reason: string }) => Promise<string>
}): Promise<T> {
  try {
    return options.parse(options.raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'parse failed'
    const repaired = await options.repair({
      routeId: options.routeId,
      raw: options.raw,
      reason,
    })
    return options.parse(repaired)
  }
}

export function applyModelInference(raw: ModelInference | string): ModelInference {
  return typeof raw === 'string' ? parseModelInferenceJson(raw) : assertModelInference(raw)
}

export function toClarifyError(error: unknown): ClarifyError {
  if (error instanceof ClarifyError) return error
  if (error instanceof ModelParseError) {
    return new ClarifyError('INVALID_ANSWER', error.message, 'retryable')
  }
  throw error
}

function rejectAdditionalProperties(record: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key))
  if (extra.length > 0) {
    throw new ModelParseError(`model output has additional properties: ${extra.join(', ')}`)
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelParseError(`model output ${field} must be a non-empty string`)
  }
  return value
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ModelParseError(`model output ${field} must be a boolean`)
  }
  return value
}

function requiredUniqueTexts(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ModelParseError(`model output ${field} must be a non-empty string array`)
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new ModelParseError(`model output ${field} must contain non-empty strings`)
  }
  if (new Set(value).size !== value.length) {
    throw new ModelParseError(`model output ${field} must not contain duplicates`)
  }
  return [...value]
}

function normalizePreview(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ')
}

function cloneAsk(value: ModelAsk): ModelAsk {
  return {
    kind: 'ask',
    question: value.question,
    options: [...value.options],
    multiple: value.multiple,
    allowCustom: value.allowCustom,
    draftPreview: value.draftPreview,
    materialChanges: [...value.materialChanges],
  }
}

function cloneAwait(value: ModelAwaitAccept): ModelAwaitAccept {
  return {
    kind: 'await_accept',
    draftPreview: value.draftPreview,
    materialChanges: [...value.materialChanges],
  }
}

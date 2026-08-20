import { createHash } from 'node:crypto'

export interface ModelRouteConfig {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface ModelVisibleInput {
  system?: string
  tools?: unknown
  messages?: unknown
}

export function modelRouteIdFromConfig(config: ModelRouteConfig): string {
  return stableHash({
    provider: config.provider ?? '',
    model: config.model ?? '',
    reasoningEffort: config.reasoningEffort ?? '',
  })
}

export function contextVersionFromModelVisible(input: ModelVisibleInput): string {
  return stableHash({
    system: input.system ?? '',
    tools: input.tools ?? null,
    messages: input.messages ?? [],
  })
}

export function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    const out: Record<string, unknown> = {}
    for (const [key, nested] of entries) out[key] = canonicalize(nested)
    return out
  }
  return value
}

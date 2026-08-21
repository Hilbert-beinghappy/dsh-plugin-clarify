import { resolveBindingSafely, type SessionsCapability } from './compat.ts'
import type { ResolvedHostBinding } from './types.ts'

export type SessionsLike = SessionsCapability

export function resolveHostBinding(sessions: SessionsLike | undefined, sessionId: string): ResolvedHostBinding {
  return resolveBindingSafely(sessions, sessionId)
}

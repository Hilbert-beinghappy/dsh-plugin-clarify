import { resolveBindingSafely, type SessionsCapability } from './compat.ts'
import type { HostBinding } from './types.ts'

export type SessionsLike = SessionsCapability

export function resolveHostBinding(sessions: SessionsLike | undefined, sessionId: string): HostBinding {
  return resolveBindingSafely(sessions, sessionId)
}

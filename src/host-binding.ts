import { resolveBindingSafely, type SessionsCapability } from './compat.ts'
import type { DefaultModelSelection } from './inference-snapshot.ts'
import type { ResolvedHostBinding } from './types.ts'

export type SessionsLike = SessionsCapability

export function resolveHostBinding(
  sessions: SessionsLike | undefined,
  sessionId: string,
  readDefaultModel?: () => DefaultModelSelection | undefined,
): ResolvedHostBinding {
  return resolveBindingSafely(sessions, sessionId, readDefaultModel)
}

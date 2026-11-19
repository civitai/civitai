import type { NextApiResponse } from 'next';
import type { Session } from '~/types/session';

export const IMPERSONATION_REFUSED = {
  error: 'impersonation_refused',
  message: 'Apps are paused while impersonating',
} as const;

/**
 * Answers 403 `impersonation_refused` and returns true when the session is an impersonation, so a
 * route that mints app credentials for the session's user mints none for a moderator acting as them.
 */
export function refuseWhileImpersonating(
  session: Pick<Session, 'impersonatedBy'> | null | undefined,
  res: NextApiResponse
): boolean {
  if (session?.impersonatedBy == null) return false;
  res.status(403).json(IMPERSONATION_REFUSED);
  return true;
}

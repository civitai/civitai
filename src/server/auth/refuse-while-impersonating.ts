import { TRPCError } from '@trpc/server';
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
  res: NextApiResponse,
  message: string = IMPERSONATION_REFUSED.message
): boolean {
  if (session?.impersonatedBy == null) return false;
  res.status(403).json({ error: IMPERSONATION_REFUSED.error, message });
  return true;
}

/** The tRPC form: throws FORBIDDEN, with `message`, when the caller's session is an impersonation. */
export function assertNotImpersonating(
  ctx: { impersonatedBy?: number | null },
  message: string = IMPERSONATION_REFUSED.message
): void {
  if (ctx.impersonatedBy == null) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message,
    cause: new Error(IMPERSONATION_REFUSED.error),
  });
}

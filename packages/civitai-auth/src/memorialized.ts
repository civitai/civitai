import type { SessionClaims, SessionUser } from './types';

/**
 * Whether a session token resolves to no one because its account is memorialized. A moderator's
 * impersonation of the account still resolves. Only token resolves ask this; by-id reads keep the account.
 */
export function refusesMemorializedSession(
  user: Pick<SessionUser, 'memorialized'>,
  claims: Pick<SessionClaims, 'impersonatedBy'>
): boolean {
  return user.memorialized === true && claims.impersonatedBy == null;
}

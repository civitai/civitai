import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { bearerToken } from './request';

// Trusted server-to-server auth: a calling service presents the shared `AUTH_INTERNAL_TOKEN` as a Bearer.
// Used by the session write endpoints (invalidate/refresh, ban/unban) and the dev-login bypass. Fails
// CLOSED — if no token is configured, nothing internal is reachable. Constant-time compare (the secret guards
// arbitrary-userId cache invalidation + the dev mint) so a `===` short-circuit can't leak it via timing.
export function isInternalRequest(request: Request): boolean {
  const expected = env.AUTH_INTERNAL_TOKEN;
  if (!expected) return false;
  const a = Buffer.from(bearerToken(request));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

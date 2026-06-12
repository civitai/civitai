import { env } from '$env/dynamic/private';

// Trusted server-to-server auth: a calling service presents the shared `AUTH_INTERNAL_TOKEN` as a Bearer.
// Used by the session write endpoints (invalidate/refresh, ban/unban) and the dev-login bypass. Fails
// CLOSED — if no token is configured, nothing internal is reachable.
export function isInternalRequest(request: Request): boolean {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = /^bearer /i.test(authHeader) ? authHeader.slice(7).trim() : '';
  return !!env.AUTH_INTERNAL_TOKEN && token === env.AUTH_INTERNAL_TOKEN;
}

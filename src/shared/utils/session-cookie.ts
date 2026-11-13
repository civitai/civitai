/**
 * Whether a cookie name is a session cookie, of either family: the hub's `civ-token` (any slot
 * prefix: `__Secure-`, `__Host-`, none) or the legacy next-auth `civitai-token`. The suffixes do
 * not subsume each other — `civitai-token` does not end with `civ-token` — so both are checked.
 *
 * Presence only, never validity. One predicate for every caller that asks "did this request carry
 * a session?": `_app` (unknown vs signed-out) and the shell refusal.
 */
const isHubSessionCookieName = (name: string) => name.endsWith('civ-token');
const isLegacySessionCookieName = (name: string) => name.endsWith('civitai-token');

export const isSessionCookieName = (name: string) =>
  isHubSessionCookieName(name) || isLegacySessionCookieName(name);

/** Whether a parsed cookie jar carries a session cookie (see `isSessionCookieName`). */
export const hasSessionCookie = (cookies: Partial<Record<string, unknown>> | null | undefined) =>
  Object.keys(cookies ?? {}).some(isSessionCookieName);

export type SessionCookieKind = 'civ-token' | 'legacy' | 'both' | 'none';

/** Which session cookie families a parsed jar carries, by name only (see `isSessionCookieName`). */
export function sessionCookieKind(
  cookies: Partial<Record<string, unknown>> | null | undefined
): SessionCookieKind {
  const names = Object.keys(cookies ?? {});
  const hub = names.some(isHubSessionCookieName);
  const legacy = names.some(isLegacySessionCookieName);
  return hub && legacy ? 'both' : hub ? 'civ-token' : legacy ? 'legacy' : 'none';
}

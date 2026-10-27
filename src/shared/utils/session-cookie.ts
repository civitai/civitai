/**
 * Whether a cookie name is a session cookie, of either family: the hub's `civ-token` (any slot
 * prefix: `__Secure-`, `__Host-`, none) or the legacy next-auth `civitai-token`. The suffixes do
 * not subsume each other — `civitai-token` does not end with `civ-token` — so both are checked.
 *
 * Presence only, never validity. One predicate for every caller that asks "did this request carry
 * a session?": `_app` (unknown vs signed-out), the shell refusal, and the page-data endpoint.
 */
export const isSessionCookieName = (name: string) =>
  name.endsWith('civ-token') || name.endsWith('civitai-token');

/** Whether a parsed cookie jar carries a session cookie (see `isSessionCookieName`). */
export const hasSessionCookie = (cookies: Partial<Record<string, unknown>> | null | undefined) =>
  Object.keys(cookies ?? {}).some(isSessionCookieName);

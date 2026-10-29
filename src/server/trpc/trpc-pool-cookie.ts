import type { IncomingMessage, ServerResponse } from 'http';
import { getCookies } from 'cookies-next';

/**
 * The routing cookie that lets the edge send an opted-in viewer's tRPC requests to the standalone
 * tRPC server. The edge can match a request, not a viewer, so the app marks the viewer: a private
 * full render sets it while the viewer's `trpcPoolRoute` flag is on and clears it once it is off.
 *
 * Modelled on the static-shell route cookie (`syncShellRouteCookie` in
 * `~/server/shell/shell-response`): host-only, so each host sets its own and no other host under
 * the same registrable domain can write the one a host's edge reads. A sibling rather than a
 * generalisation of that helper because it is `HttpOnly` (only the edge reads it), and changing
 * the shell cookie's attributes would change what its existing holders' browsers send.
 *
 * 🔴 Not a fast kill switch: once the flag is off, a holder keeps the cookie until their next full
 * render, for up to `TRPC_POOL_COOKIE_MAX_AGE_S`.
 */
export const TRPC_POOL_COOKIE = 'civ-trpc-pool';

/** Seven days. A full render sets the cookie when absent; nothing re-sets one that is there. */
export const TRPC_POOL_COOKIE_MAX_AGE_S = 604800;

const attributes = (maxAge: number) => `Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

/**
 * Writes `cookie` as this response's only Set-Cookie for the routing cookie, keeping every other
 * one. `_app` can run twice on one response (a page's `notFound` or throw), and two entries for one
 * name would leave the browser with whichever came last.
 */
function putSetCookie(res: ServerResponse, cookie: string) {
  const existing = ([] as unknown[]).concat(res.getHeader('Set-Cookie') ?? []).map(String);
  const others = existing.filter((entry) => !entry.startsWith(`${TRPC_POOL_COOKIE}=`));
  res.setHeader('Set-Cookie', [...others, cookie]);
}

/**
 * Keeps the routing cookie in step with the viewer's flag, from a PRIVATE response only: set
 * (`civ-trpc-pool=1`) while `enabled` and the request does not already carry it, cleared once
 * `enabled` is false and the request carries it. `enabled` must be false for an anonymous viewer;
 * the caller decides it.
 */
export function syncTrpcPoolCookie(req: IncomingMessage, res: ServerResponse, enabled: boolean) {
  const value = getCookies({ req: req as never })[TRPC_POOL_COOKIE];
  if (enabled && value !== '1') {
    putSetCookie(res, `${TRPC_POOL_COOKIE}=1; ${attributes(TRPC_POOL_COOKIE_MAX_AGE_S)}`);
  } else if (!enabled && value !== undefined) {
    putSetCookie(res, `${TRPC_POOL_COOKIE}=; ${attributes(0)}`);
  }
}

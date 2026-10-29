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
 * True when the response already says a shared cache may store it: `Cache-Control` with `public`
 * or `s-maxage`. Routing headers from `next.config` `headers()` (the sitemap routes'
 * `public, max-age=86400`) are written onto the response before the page renders, so `_app` sees
 * them here. A page's own `getServerSideProps` runs after `_app` and is not seen.
 */
function isSharedCacheable(res: ServerResponse) {
  const cacheControl = ([] as unknown[]).concat(res.getHeader('Cache-Control') ?? []).join(',');
  return /(^|[\s,])(public|s-maxage)([\s,=]|$)/i.test(cacheControl);
}

/**
 * Keeps the routing cookie in step with the viewer's flag, from a PRIVATE response only: set
 * (`civ-trpc-pool=1`) while `enabled` and the request does not already carry it, cleared once
 * `enabled` is false and the request carries it. `enabled` must be false for an anonymous viewer;
 * the caller decides it.
 *
 * Writes nothing on a response a shared cache may store (one viewer's cookie would be served to
 * others), or on one whose headers are already sent (`_app` re-runs on the sent response after a
 * redirect, a `notFound` or a throw, and `setHeader` would throw `ERR_HTTP_HEADERS_SENT`).
 */
export function syncTrpcPoolCookie(req: IncomingMessage, res: ServerResponse, enabled: boolean) {
  const value = getCookies({ req: req as never })[TRPC_POOL_COOKIE];
  let cookie: string | undefined;
  if (enabled && value !== '1') {
    cookie = `${TRPC_POOL_COOKIE}=1; ${attributes(TRPC_POOL_COOKIE_MAX_AGE_S)}`;
  } else if (!enabled && value !== undefined) {
    cookie = `${TRPC_POOL_COOKIE}=; ${attributes(0)}`;
  }
  // Checked only when there is something to write: a request in step touches no response header.
  if (cookie === undefined || res.headersSent || isSharedCacheable(res)) return;
  putSetCookie(res, cookie);
}

import type { IncomingMessage, ServerResponse } from 'http';
import { getCookies } from 'cookies-next';
import { appendSetCookie } from '~/server/utils/set-cookie';

/**
 * The routing cookie that lets the edge send an opted-in viewer's tRPC requests to the standalone
 * tRPC server. The edge can match a request, not a viewer, so the app marks the viewer: a private
 * full render sets it while the viewer's `trpcPoolRoute` flag is on and clears it once it is off.
 *
 * Host-only (no Domain), so no sibling host can write the cookie this host's edge reads. Separate
 * from `syncShellRouteCookie`: this one is HttpOnly.
 *
 * 🔴 Not a fast kill switch: a holder keeps the cookie until their next full render after the flag
 * goes off.
 */
export const TRPC_POOL_COOKIE = 'civ-trpc-pool';

export const TRPC_POOL_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

const attributes = (maxAge: number) => `Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

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
 * Replaces its own entry rather than appending, since `_app` can run twice on one response.
 */
export function syncTrpcPoolCookie(req: IncomingMessage, res: ServerResponse, enabled: boolean) {
  const value = getCookies({ req: req as never })[TRPC_POOL_COOKIE];
  let cookie: string | undefined;
  if (enabled && value !== '1') {
    cookie = `${TRPC_POOL_COOKIE}=1; ${attributes(TRPC_POOL_COOKIE_MAX_AGE_S)}`;
  } else if (!enabled && value !== undefined) {
    cookie = `${TRPC_POOL_COOKIE}=; ${attributes(0)}`;
  }
  if (cookie === undefined || res.headersSent || isSharedCacheable(res)) return;
  appendSetCookie(res, cookie, { replace: true });
}

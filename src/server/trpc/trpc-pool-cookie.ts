import type { IncomingMessage, ServerResponse } from 'http';
import { getCookies } from 'cookies-next';
import { cookieDomainForHost } from '~/server/auth/civ-cookie';
import { ROUTE_COOKIE_MAX_AGE_S } from '~/server/shell/shell-response';
import { SHELL_EDGE_HEADERS } from '~/shared/constants/shell.constants';

/**
 * The routing cookie that lets the edge send an opted-in viewer's tRPC requests to the standalone
 * tRPC server. The edge can match a request, not a viewer, so the app marks the viewer: a private
 * full render sets it while the viewer's `trpcPoolRoute` flag is on and clears it once it is off.
 *
 * Modelled on the static-shell route cookie (`syncShellRouteCookie` in
 * `~/server/shell/shell-response`), with three differences, which is why it is a sibling and not
 * a generalisation of that helper: it is `HttpOnly` (only the edge reads it), it carries the
 * session cookie's Domain (`cookieDomainForHost`) so one cookie covers every host of a colour, and
 * it refuses any response that is already marked cacheable. Changing the shell cookie's attributes
 * would change which cookie its existing holders' browsers send, so it is left as it is.
 */
export const TRPC_POOL_COOKIE = 'civ-trpc-pool';

/**
 * Whether `res` is already marked as storable by a shared cache: a `public` or `s-maxage`
 * Cache-Control, or any header only an edge-cacheable shell carries. A Set-Cookie on such a
 * response could be handed to every viewer, so the routing cookie is never written there.
 */
export function isSharedCacheableResponse(res: ServerResponse): boolean {
  const cacheControl = ([] as unknown[])
    .concat(res.getHeader('Cache-Control') ?? [])
    .map(String)
    .join(',')
    .toLowerCase();
  if (/(^|[\s,])(public|s-maxage)\b/.test(cacheControl)) return true;
  return SHELL_EDGE_HEADERS.some((name) => res.getHeader(name) !== undefined);
}

function cookieAttributes(req: IncomingMessage, maxAge: number) {
  const domain = cookieDomainForHost(req.headers.host);
  return [
    'Path=/',
    ...(domain ? [`Domain=${domain}`] : []),
    `Max-Age=${maxAge}`,
    'Secure',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

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
 * `enabled` is false and the request carries it. Writes nothing on a response a shared cache may
 * store. `enabled` must be false for an anonymous viewer; the caller decides it.
 */
export function syncTrpcPoolCookie(req: IncomingMessage, res: ServerResponse, enabled: boolean) {
  const value = getCookies({ req: req as never })[TRPC_POOL_COOKIE];
  const cookie =
    enabled && value !== '1'
      ? `${TRPC_POOL_COOKIE}=1; ${cookieAttributes(req, ROUTE_COOKIE_MAX_AGE_S)}`
      : !enabled && value !== undefined
      ? `${TRPC_POOL_COOKIE}=; ${cookieAttributes(req, 0)}`
      : null;
  if (cookie && !isSharedCacheableResponse(res)) putSetCookie(res, cookie);
}

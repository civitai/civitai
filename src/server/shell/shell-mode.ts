import type { IncomingMessage } from 'http';
import { getCookies } from 'cookies-next';
import { resolveAuthGuard } from '~/server/auth/route-guard';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { getRegion, isRegionBlocked, isRegionRestricted } from '~/server/utils/region-blocking';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { isPreview, isProd } from '~/env/other';
import { SHELL_BYPASS_PARAM, SHELL_BYPASS_VALUE } from '~/shared/constants/shell.constants';
import { isNextDataRequest } from '~/server/prom/ssr-cpu.metrics';
import {
  isCanonicalShellPath,
  requestPath,
  SHELL_CANONICAL_ROUTES,
  SHELL_ORIGINAL_URL_HEADER,
  shellOriginalUrl,
} from '~/server/shell/shell-canonical';

/**
 * Static shell mode: whether a page request is answered with the route's static shell — one HTML
 * for every viewer and every URL of the route, which the client fills from the page-data endpoint
 * after hydration — instead of a full per-viewer render.
 *
 * 🔴 The decision reads ONLY request facts that do not identify the viewer — method, route, a few
 * headers, whether a session cookie is present (never its value), the route cookie, and one flag
 * evaluated with no user — so nothing that differs between two viewers can reach the shell's bytes.
 * The per-user rollout (`shell-images`) is read only in responses that are already private, which
 * set or clear the route cookie (`~/server/shell/shell-response`).
 */

export const SHELL_ROUTES = {
  '/images/[imageId]': {
    name: 'images',
    /** Set by a private response for a viewer the route's flag is on for. */
    cookie: 'civ-shell-images',
    /** The per-user rollout behind the cookie. */
    flag: 'shellImages',
  },
} as const satisfies Record<string, { name: string; cookie: string; flag: FeatureFlagKey }>;

export type ShellRoutePattern = keyof typeof SHELL_ROUTES;
export type ShellRouteName = (typeof SHELL_ROUTES)[ShellRoutePattern]['name'];
export type ShellRoute = (typeof SHELL_ROUTES)[ShellRoutePattern];

export function shellRouteByName(name: ShellRouteName): ShellRoute {
  return Object.values(SHELL_ROUTES).find((route) => route.name === name)!;
}

/** Why a request is not answered with a shell. Each is checked on its own; see `shellRefusal`. */
export type ShellRefusal =
  | 'method'
  | 'route'
  | 'original-url'
  | 'data-request'
  | 'bypass'
  | 'verified-bot'
  | 'authorization'
  | 'query-token'
  | 'no-session-cookie'
  | 'no-route-cookie'
  | 'region'
  | 'auth-guard'
  | 'kill-switch';

type ShellRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
  cookies?: Partial<Record<string, string>>;
};

/** Either session cookie family, as `_app` matches them (`civ-token` does not suffix `civitai-token`). */
const isSessionCookieName = (name: string) =>
  name.endsWith('civ-token') || name.endsWith('civitai-token');

function queryParam(url: string, name: string): string | null {
  const queryString = url.split('?')[1];
  return queryString ? new URLSearchParams(queryString).get(name) : null;
}

/**
 * The URLs a request is judged on: its own, and — on the route's canonical path
 * (`~/server/shell/shell-canonical`) — the original URL the edge rewrote from, or `null` when that
 * request carries no valid one. Every URL-dependent refusal must hold for each of them.
 */
function judgedUrls(req: ShellRequest, route: ShellRoute): string[] | null {
  const own = req.url ?? '';
  if (!(route.name in SHELL_CANONICAL_ROUTES) || !isCanonicalShellPath(route.name, own)) {
    return [own];
  }
  const original = shellOriginalUrl(route.name, req.headers[SHELL_ORIGINAL_URL_HEADER]);
  return original ? [own, original] : null;
}

/**
 * A request on a shell route's canonical path. One that is not answered with the shell is
 * bounced by the page's getServerSideProps, so `_app` need not prepare a full render for it.
 */
export function isCanonicalShellRequest(req: ShellRequest, pathname: string): boolean {
  if (!(pathname in SHELL_ROUTES)) return false;
  const route = SHELL_ROUTES[pathname as ShellRoutePattern];
  return route.name in SHELL_CANONICAL_ROUTES && isCanonicalShellPath(route.name, req.url);
}

/**
 * The first reason `req` must get a full render, or `null` when it gets the shell. `pathname` is
 * the page pattern Next rendered (`ctx.pathname`), never the URL.
 *
 * Bots carry no session cookie, so they never reach a shell; a verified bot is refused on its own
 * as well. A session cookie is all this checks — never that it is valid: a dead one is served the
 * shell, whose page-data request then answers 404 and sends the page to `?civ-shell=0`.
 */
export async function shellRefusal(
  req: ShellRequest,
  pathname: string
): Promise<ShellRefusal | null> {
  if (req.method !== 'GET') return 'method';
  if (!(pathname in SHELL_ROUTES)) return 'route';
  const route = SHELL_ROUTES[pathname as ShellRoutePattern];
  // On the canonical path the URL that matters is the one the browser asked for.
  const urls = judgedUrls(req, route);
  if (!urls) return 'original-url';
  // A client-side navigation's data request is answered by getServerSideProps alone: no HTML.
  if (isNextDataRequest(req as never)) return 'data-request';
  if (urls.some((url) => queryParam(url, SHELL_BYPASS_PARAM) === SHELL_BYPASS_VALUE)) {
    return 'bypass';
  }
  if (parseVerifiedBotHeader(req.headers[VERIFIED_BOT_HEADER])) return 'verified-bot';
  // Credentials other than the cookie: the page would be rendered for THAT caller.
  if (req.headers.authorization) return 'authorization';
  if (
    requestCarriesQueryToken(req as never) ||
    urls.some((url) => requestCarriesQueryToken({ url } as never))
  ) {
    return 'query-token';
  }

  const cookies = getCookies({ req: req as never });
  const names = Object.keys(cookies);
  if (!names.some(isSessionCookieName)) return 'no-session-cookie';
  if (cookies[route.cookie] !== '1') return 'no-route-cookie';

  // The proxy redirects these first; refused here too so the shell never depends on that order.
  const region = getRegion(req);
  if (isRegionBlocked(region) || isRegionRestricted(region)) return 'region';
  // A guarded path needs the session to decide, which a shell render does not read.
  if (urls.some((url) => resolveAuthGuard(requestPath(url), null, { isProd, isPreview }))) {
    return 'auth-guard';
  }

  const host = req.headers.host;
  const flags = await getFeatureFlagsAsync({ host });
  if (!flags.shellMaster) return 'kill-switch';
  return null;
}

/** The shell route `req` is rendered as, or `null` for a full render. */
export async function resolveShellMode(
  req: ShellRequest,
  pathname: string
): Promise<ShellRouteName | null> {
  return (await shellRefusal(req, pathname)) === null
    ? SHELL_ROUTES[pathname as ShellRoutePattern].name
    : null;
}

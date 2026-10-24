import type { NextApiRequest, NextApiResponse } from 'next';
import { PRIVATE_CACHE_CONTROL } from '~/server/middleware/middleware-utils';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { verifyBot, type VerifiedBot } from '~/server/utils/bot-detection/verify-bot';
import { getRegion, isAPIAccessBlocked, type RegionInfo } from '~/server/utils/region-blocking';

/**
 * The three proxy middlewares that change anything on an API request, as pure functions:
 * `apiRegionBlockMiddleware` (451), `apiCacheMiddleware` (default response headers) and
 * `botDetectionMiddleware` (the verified-crawler request header). The middlewares call these,
 * and so does the tRPC route through `applyApiRequestPolicy`, so the two cannot drift.
 *
 * The route applies them on EVERY request, whether or not the proxy already did. Each is
 * idempotent: a request the proxy blocked never reaches the route, the headers are set to the
 * same values, and the bot header is re-derived from the same user agent and client IP. That is
 * what lets the proxy stop running on `/api/trpc` (see `TRPC_SKIP_PROXY_MIDDLEWARE_FLAG`)
 * without the route's behaviour depending on which one ran.
 */

/**
 * Flipt key (global boolean, no entity or context). ON: the proxy returns a bare passthrough for
 * `/api/trpc/*` and the route alone applies this policy. OFF, missing, or Flipt not ready: the
 * proxy runs its middlewares as before. Read by `proxy.ts`.
 */
export const TRPC_SKIP_PROXY_MIDDLEWARE_FLAG = 'trpc-skip-proxy-middleware';

export const TRPC_PATH_PREFIX = '/api/trpc/';

// --- region block -----------------------------------------------------------------------------

export type ApiRegionBlock = { status: 451; contentType: 'application/json'; body: string };

const API_REGION_BLOCK: ApiRegionBlock = {
  status: 451, // Unavailable For Legal Reasons
  contentType: 'application/json',
  body: JSON.stringify({
    error: 'Access to this service is not available in your region due to legal restrictions.',
    code: 'REGION_BLOCKED',
  }),
};

/** The 451 an API request from `region` must get, or null when the region may use the API. */
export function getApiRegionBlock(region: RegionInfo): ApiRegionBlock | null {
  return isAPIAccessBlocked(region) ? API_REGION_BLOCK : null;
}

// --- default response headers -----------------------------------------------------------------

/** The response headers every matched API response starts with; a handler may override them. */
export function getApiDefaultResponseHeaders(
  podName: string | undefined = process.env.PODNAME
): [string, string][] {
  const headers: [string, string][] = [['Cache-Control', PRIVATE_CACHE_CONTROL]];
  if (podName) headers.push(['X-Handled-By', podName]);
  return headers;
}

// --- verified-crawler request header ------------------------------------------------------------

// Detail-page filter: only entity URLs where the segment after the prefix is numeric (e.g.
// /models/123/slug). Excludes listing pages (/models), create/edit flows (/models/create), and
// static assets that share the prefix (/images/android-chrome-192x192.png).
const DETAIL_PAGE_RE =
  /^\/(?:models|images|posts|articles|bounties|challenges|collections)\/\d+(?:\/|$)/;

// API filter: tRPC and public REST routes — client-side queries fired during page hydration go
// through these paths and need the bot header for `applyDomainFeature` to skip the anonymous cap.
const API_PATH_RE = /^\/api\/(?:trpc|v1)\//;

export const isBotAwarePath = (path: string) => DETAIL_PAGE_RE.test(path) || API_PATH_RE.test(path);

type HeaderGetter = (name: string) => string | null | undefined;

/**
 * Cloudflare sets cf-connecting-ip with the real client IP. Fall back to x-forwarded-for
 * (proxies, curl-spoofed local tests). In dev with a direct browser hit to localhost, neither
 * header is reliably set — fall back to '127.0.0.1' so BOT_TEST_IPS=127.0.0.1 actually matches.
 */
export function getClientIp(
  getHeader: HeaderGetter,
  isDev = process.env.NODE_ENV !== 'production'
): string | null {
  const detected =
    getHeader('cf-connecting-ip') ?? getHeader('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  if (detected) return detected;
  if (isDev) return '127.0.0.1';
  return null;
}

export type VerifiedBotHeaderChange = { set: VerifiedBot } | { remove: true } | null;

/**
 * What the verified-crawler request header must become. Only this decision may set it: a value
 * that arrived with the request is removed unless the request verifies as a crawler on a path
 * that uses it. `null` means leave the request as it is.
 */
export function resolveVerifiedBotHeader(
  pathname: string,
  getHeader: HeaderGetter
): VerifiedBotHeaderChange {
  const bot = isBotAwarePath(pathname)
    ? verifyBot(getHeader('user-agent'), getClientIp(getHeader))
    : null;
  if (bot) return { set: bot };
  return getHeader(VERIFIED_BOT_HEADER) != null ? { remove: true } : null;
}

// --- route-side application ---------------------------------------------------------------------

function nodeHeaderGetter(req: NextApiRequest): HeaderGetter {
  return (name) => {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
}

/**
 * Applies the API policy inside a pages API route, exactly as the proxy middlewares do: 451 for a
 * blocked region (ends the response, returns true), else the default response headers and the
 * verified-crawler request header. Safe to run after the proxy already applied it.
 */
export function applyApiRequestPolicy(req: NextApiRequest, res: NextApiResponse): boolean {
  const getHeader = nodeHeaderGetter(req);

  const block = getApiRegionBlock(getRegion(req));
  if (block) {
    res.statusCode = block.status;
    res.setHeader('Content-Type', block.contentType);
    res.end(block.body);
    return true;
  }

  for (const [name, value] of getApiDefaultResponseHeaders()) res.setHeader(name, value);

  const pathname = (req.url ?? '').split('?', 1)[0];
  const change = resolveVerifiedBotHeader(pathname, getHeader);
  if (change && 'set' in change) req.headers[VERIFIED_BOT_HEADER] = change.set;
  else if (change) delete req.headers[VERIFIED_BOT_HEADER];

  return false;
}

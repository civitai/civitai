import type { IncomingMessage, ServerResponse } from 'http';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { isNextDataRequest } from '~/server/prom/ssr-cpu.metrics';
import { applyShellPrivateHeaders } from '~/server/shell/shell-response';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';
import { getRegion, isRegionBlocked, isRegionRestricted } from '~/server/utils/region-blocking';
import { requestCarriesQueryToken } from '~/server/utils/request-query-token';
import { isHostForColor } from '~/server/utils/server-domain';
import { timingSafeEqualStrings } from '~/server/utils/timing-safe-equal';
import {
  BOT_CACHE_PREFETCH_FAILED_REQ_KEY,
  BOT_CACHE_REQ_KEY,
} from '~/shared/constants/bot-cache.constants';
import type { BotCacheRouteName, BotCacheRoutePattern } from '~/server/bot-cache/bot-cache-routes';
import { BOT_CACHE_ROUTES } from '~/server/bot-cache/bot-cache-routes';

/**
 * Bot HTML cache: whether a verified crawler's full page render may be stored by the origin cache
 * (`~/server/bot-cache/bot-cache-origin`) and served to other crawlers. The render is the anonymous
 * one, made viewer-independent by `_app` (no region, a per-URL seed, no `verifiedBot`), so only
 * request facts that are part of the cache key, or that this predicate requires of every request
 * it serves, may decide it.
 *
 * The response carries no edge-cache directive: the edge cannot scope a cache to verified
 * crawlers, and a shared copy of this render served to people would skip their consent banner.
 *
 * Green (civitai.com) only: on a mature-capable host a verified bot's render carries content an
 * anonymous viewer does not get, so it cannot be shared.
 */

export { BOT_CACHE_ROUTES } from '~/server/bot-cache/bot-cache-routes';
export type { BotCacheRouteName, BotCacheRoutePattern } from '~/server/bot-cache/bot-cache-routes';

/** Set by the edge on a verified crawler's request, to `CF_VERIFIED_BOT_HEADER_SECRET`. */
export const CF_VERIFIED_BOT_HEADER = 'x-civ-cf-verified-bot';

/** Why a request is not answered with a cacheable render. See `botCacheRefusal`. */
export type BotCacheRefusal =
  | 'method'
  | 'route'
  | 'data-request'
  | 'host'
  | 'authorization'
  | 'query-token'
  | 'cookie'
  | 'region'
  | 'no-bot-header'
  | 'no-secret'
  | 'bot-header-mismatch'
  | 'degraded'
  | 'kill-switch';

type BotCacheRequest = IncomingMessage & {
  query?: Record<string, string | string[] | undefined>;
};

const readSwitch = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.BOT_HTML_EDGE_CACHE);
let flagGate = createCachedFlagGate(readSwitch);

/** Tests only: forget the cached switch read so the next request re-reads Flipt. */
export const resetBotCacheFlagGateForTests = () => {
  flagGate = createCachedFlagGate(readSwitch);
};

function isGreenOnlyHost(host: string | undefined) {
  if (!host) return false;
  return (
    isHostForColor(host, 'green') && !isHostForColor(host, 'blue') && !isHostForColor(host, 'red')
  );
}

function carriesTokenParam(req: BotCacheRequest) {
  const queryString = (req.url ?? '').split('?')[1];
  // `has`, not the shared helper alone: that treats an empty `?token=` as absent; this refuses it.
  if (queryString && new URLSearchParams(queryString).has('token')) return true;
  return requestCarriesQueryToken(req as never);
}

function headerValue(raw: string | string[] | undefined) {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The first reason `req` must not get a cacheable render, or `null` when it may. `pathname`
 * is the page pattern Next rendered (`ctx.pathname`). `degraded`: the settings bootstrap failed, so
 * the render is not the one a healthy request gets and must not be stored.
 */
export function botCacheRefusal(
  req: BotCacheRequest,
  pathname: string,
  { degraded }: { degraded: boolean }
): BotCacheRefusal | null {
  if (req.method !== 'GET') return 'method';
  if (!(pathname in BOT_CACHE_ROUTES)) return 'route';
  if (isNextDataRequest(req as never)) return 'data-request';
  if (!isGreenOnlyHost(req.headers.host)) return 'host';
  if (req.headers.authorization !== undefined) return 'authorization';
  if (carriesTokenParam(req)) return 'query-token';
  if ((req.headers.cookie ?? '').trim() !== '') return 'cookie';
  const region = getRegion(req);
  if (isRegionBlocked(region) || isRegionRestricted(region)) return 'region';

  const presented = headerValue(req.headers[CF_VERIFIED_BOT_HEADER]);
  if (!presented) return 'no-bot-header';
  const secret = env.CF_VERIFIED_BOT_HEADER_SECRET;
  if (!secret) return 'no-secret';
  if (!timingSafeEqualStrings(secret, presented)) return 'bot-header-mismatch';

  if (degraded) return 'degraded';
  if (!flagGate()) return 'kill-switch';
  return null;
}

/** The bot-cache route `req` is rendered as, or `null` for an ordinary render. */
export function resolveBotCacheRoute(
  req: BotCacheRequest,
  pathname: string,
  render: { degraded: boolean }
): BotCacheRouteName | null {
  return botCacheRefusal(req, pathname, render) === null
    ? BOT_CACHE_ROUTES[pathname as BotCacheRoutePattern]
    : null;
}

/**
 * A stable stand-in for `_app`'s per-request `seed` (`Date.now()`), so two renders of one URL are
 * the same bytes while different URLs still spread over the seeded picks. 32-bit FNV-1a.
 */
export function botCacheSeed(url: string | undefined): number {
  let hash = 0x811c9dc5;
  for (const char of url ?? '') {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Why a rendered response may not be cached. See `botCacheResponseRefusal`. */
export type BotCacheResponseRefusal = 'not-eligible' | 'prefetch-failed' | 'status';

type MarkedRequest = {
  [BOT_CACHE_REQ_KEY]?: string;
  [BOT_CACHE_PREFETCH_FAILED_REQ_KEY]?: boolean;
};

/**
 * After the page rendered (`_document.getInitialProps`): `null` when the response may be cached.
 * Needs `_app`'s mark for THIS page pattern — a `notFound` or a throw re-renders as `/404`
 * or `/_error`, which never matches — no failed prefetch (the page would be stored without its
 * data), and a 200.
 */
export function botCacheResponseRefusal(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): BotCacheResponseRefusal | null {
  const marks = req as MarkedRequest;
  const route = BOT_CACHE_ROUTES[pathname as BotCacheRoutePattern];
  if (!route || marks[BOT_CACHE_REQ_KEY] !== route) return 'not-eligible';
  if (marks[BOT_CACHE_PREFETCH_FAILED_REQ_KEY]) return 'prefetch-failed';
  if (res.statusCode !== 200) return 'status';
  return null;
}

/**
 * A cacheable render is private to browsers and other caches (`private, no-store`) and sets no
 * cookie, since a stored Set-Cookie would be handed to every crawler. No edge-cache directive: see
 * the note at the top of this file.
 */
export function applyBotCachePrivateHeaders(res: ServerResponse) {
  applyShellPrivateHeaders(res);
}

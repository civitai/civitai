import { promisify } from 'util';
import zlib from 'zlib';
import type { IncomingMessage, ServerResponse } from 'http';
import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import type { BotCacheRoutePattern } from '~/server/bot-cache/bot-cache-routes';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { withCommandDeadline } from '~/server/redis/command-deadline';
import { shellBuildId, UNKNOWN_BUILD_ID } from '~/server/shell/shell-response';
import { createLogThrottle } from '~/server/utils/log-throttle';
import {
  BOT_CACHE_LOOKUP_FAILED,
  BOT_CACHE_STATUS_HEADER,
} from '~/shared/constants/bot-cache.constants';
import { isMobileUserAgent } from '~/shared/utils/mobile-user-agent';

/**
 * Bot HTML origin cache: a cacheable crawler render (`~/server/bot-cache/bot-cache`) is kept in
 * redis for a few minutes, so a repeat request for the same URL is answered by the proxy
 * (`~/server/middleware/bot-cache.middleware`) instead of being rendered again. Only a response
 * `botCacheResponseRefusal` allows is stored, and only a request `botCacheRefusal` allows is
 * served.
 */

export const BOT_CACHE_ORIGIN_TTL_S = 300;
/** Compressed. A larger page is rendered every time rather than crowd the cache. */
export const BOT_CACHE_ORIGIN_MAX_STORED_BYTES = 256 * 1024;
export const BOT_CACHE_ORIGIN_LOOKUP_TIMEOUT_MS = 25;
// Buffering stops here so a runaway page cannot hold memory until its response ends; at the ~5-6x
// brotli ratio of these pages, a body this large would be over the stored cap anyway.
const MAX_CAPTURED_BYTES = 4 * 1024 * 1024;
const BROTLI_QUALITY = 6;

/** The render's headers a hit sends again. Never `Set-Cookie`. */
const REPLAYED_HEADERS = [
  'content-type',
  'cache-control',
  'x-robots-tag',
  'content-language',
  'link',
  'vary',
];

export type BotCacheEntry = {
  /** The page pattern the stored render was rendered as (`ctx.pathname`). */
  pattern: BotCacheRoutePattern;
  headers: Record<string, string>;
  /** Brotli-compressed HTML. */
  body: Uint8Array;
};

// Not `redis.packed`'s `compress`: the stored-size cap is checked on the compressed length, which
// that codec compresses inside `set` and never returns.
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

function compareEntries([ak, av]: [string, string], [bk, bv]: [string, string]) {
  if (ak !== bk) return ak < bk ? -1 : 1;
  if (av !== bv) return av < bv ? -1 : 1;
  return 0;
}

export type BotCacheKey = `${typeof REDIS_KEYS.BOT_CACHE.HTML}:${string}`;

/**
 * `pathname` must be the WHATWG-parsed path with no locale prefix: what `nextUrl.pathname` is in
 * the proxy, and what `new URL(req.url)` gives at render, where Next has already stripped it.
 * `null` without a real build id: every build would share the one fallback, and a page from one
 * build would be served after another is deployed.
 */
export function botCacheKey(
  host: string,
  pathname: string,
  search: string,
  userAgent: string | undefined,
  buildId: string = shellBuildId()
): BotCacheKey | null {
  if (!buildId || buildId === UNKNOWN_BUILD_ID) return null;
  const prefix = REDIS_KEYS.BOT_CACHE.HTML;
  const query = new URLSearchParams([...new URLSearchParams(search)].sort(compareEntries));
  // Some pages render a phone layout by user agent: mobile and desktop crawlers must not share HTML.
  const device = isMobileUserAgent(userAgent) ? 'm' : 'd';
  return `${prefix}:${buildId}:${device}:${host.toLowerCase()}:${pathname}?${query.toString()}`;
}

export const BOT_CACHE_ORIGIN_METRIC = PROM_PREFIX + 'bot_html_origin_cache_total';

type OriginCacheEvent = 'hit' | 'miss' | 'store' | 'skip_too_large' | 'error';
type OriginCachePhase = 'lookup' | 'store';

// On the shared registry: lookups are counted from the proxy's module graph, stores from the
// page's, and `/api/metrics` scrapes this one for both.
function originCacheCounter(): Counter<'event' | 'phase'> {
  return registerInstrumentationMetric(
    BOT_CACHE_ORIGIN_METRIC,
    () =>
      new client.Counter({
        name: BOT_CACHE_ORIGIN_METRIC,
        help:
          'Bot HTML origin cache: lookups (hit, miss, error) for requests allowed a cacheable ' +
          'crawler render, and stores (store, skip_too_large, error) of such renders',
        labelNames: ['event', 'phase'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

export function recordBotCacheOrigin(event: OriginCacheEvent, phase: OriginCachePhase) {
  try {
    originCacheCounter().inc({ event, phase });
  } catch {
    // Telemetry never fails the request.
  }
}

const shouldLogFailure = createLogThrottle(60_000);

/** At most one log line a minute: when redis is down every crawler request fails the same way. */
export function logBotCacheOriginFailure(phase: OriginCachePhase, error: unknown) {
  if (!shouldLogFailure('bot-html-origin-cache')) return;
  void import('~/server/logging/client')
    .then(({ logToAxiom, safeError }) =>
      logToAxiom({
        ...safeError(error),
        name: 'bot-html-origin-cache',
        type: 'warning',
        phase,
      })
    )
    .catch(() => undefined);
}

/** Rejects on a redis error or after `BOT_CACHE_ORIGIN_LOOKUP_TIMEOUT_MS`. */
export function readBotCacheEntry(key: BotCacheKey) {
  return withCommandDeadline(
    redis.packed.get<BotCacheEntry>(key),
    BOT_CACHE_ORIGIN_LOOKUP_TIMEOUT_MS
  );
}

export async function decodeBotCacheBody(entry: BotCacheEntry): Promise<string> {
  return (await brotliDecompress(entry.body)).toString('utf8');
}

/** Never rejects. */
export async function storeBotCacheRender(
  key: BotCacheKey,
  pattern: BotCacheRoutePattern,
  headers: Record<string, string>,
  html: Buffer
) {
  try {
    const body = await brotliCompress(html, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: html.length,
      },
    });
    if (body.length > BOT_CACHE_ORIGIN_MAX_STORED_BYTES) {
      recordBotCacheOrigin('skip_too_large', 'store');
      return;
    }
    const entry: BotCacheEntry = { pattern, headers, body };
    await redis.packed.set(key, entry, { EX: BOT_CACHE_ORIGIN_TTL_S });
    recordBotCacheOrigin('store', 'store');
  } catch (error) {
    recordBotCacheOrigin('error', 'store');
    logBotCacheOriginFailure('store', error);
  }
}

function replayedHeaders(res: ServerResponse) {
  const headers: Record<string, string> = {};
  for (const name of REPLAYED_HEADERS) {
    const value = res.getHeader(name);
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

type Chunk = string | Uint8Array | null | undefined | (() => void);

/**
 * Keeps a copy of the HTML Next writes for this response and stores it once the response has
 * ended, if it is still a 200 without a cookie. Call only for a response `botCacheResponseRefusal`
 * allows (`_document`). Next writes the page with `res.end(html)` (`send-payload.js`), or streams
 * it through `res.write`; `compress: false`, so these are the uncompressed bytes.
 *
 * Not after a lookup that failed or timed out (the proxy's status header, which Next copies onto
 * the page request): redis is degraded, and a store would only add to its load.
 */
export function captureBotCacheRender(
  req: IncomingMessage,
  res: ServerResponse,
  pattern: BotCacheRoutePattern
) {
  if (req.headers[BOT_CACHE_STATUS_HEADER] === BOT_CACHE_LOOKUP_FAILED) return;
  const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
  const key = botCacheKey(req.headers.host ?? '', pathname, search, req.headers['user-agent']);
  if (!key) return;
  const chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;
  let ended = false;

  const collect = (chunk: Chunk, encoding: unknown) => {
    if (overflow || chunk == null || typeof chunk === 'function') return;
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
        : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_CAPTURED_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  };

  const originalWrite = res.write;
  const originalEnd = res.end;
  if (typeof originalWrite === 'function') {
    res.write = function (this: ServerResponse, chunk: Chunk, ...rest: unknown[]) {
      collect(chunk, rest[0]);
      return Reflect.apply(originalWrite, this, [chunk, ...rest]);
    } as unknown as ServerResponse['write'];
  }
  res.end = function (this: ServerResponse, chunk?: Chunk, ...rest: unknown[]) {
    collect(chunk, rest[0]);
    const result = Reflect.apply(originalEnd, this, [chunk, ...rest]);
    if (!ended) {
      ended = true;
      if (res.statusCode !== 200 || res.getHeader('set-cookie') !== undefined) return result;
      if (overflow) recordBotCacheOrigin('skip_too_large', 'store');
      else void storeBotCacheRender(key, pattern, replayedHeaders(res), Buffer.concat(chunks));
    }
    return result;
  } as unknown as ServerResponse['end'];
}

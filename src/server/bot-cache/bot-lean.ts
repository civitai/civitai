import type { IncomingMessage, ServerResponse } from 'http';
import client from 'prom-client';
import type { Counter } from 'prom-client';
import {
  PROM_PREFIX,
  instrumentationRegistry,
  registerInstrumentationMetric,
} from '@civitai/telemetry/client';
import {
  ensureFliptInitialized,
  FLIPT_FEATURE_FLAGS,
  getFliptClientSync,
  isFliptSync,
} from '~/server/flipt/client';
import { applyBotCachePrivateHeaders } from '~/server/bot-cache/bot-cache';
import type { BotCacheRouteName } from '~/server/bot-cache/bot-cache-routes';
import { createCachedFlagGate } from '~/server/utils/otel-withspan-gate';
import { createLogThrottle } from '~/server/utils/log-throttle';
import { BOT_CACHE_REQ_KEY } from '~/shared/constants/bot-cache.constants';

/**
 * Bot lean render: a verified crawler's page answered with a small template-string HTML document
 * carrying the same SEO content as the full render (title, meta, canonical, robots, Open Graph,
 * JSON-LD, the main text, the main `<img>` and the internal links), without the React tree,
 * `trpcState` or `__NEXT_DATA__`.
 *
 * Reachable ONLY by a request `_app` marked as a bot-cache render (`~/server/bot-cache/bot-cache`):
 * a GET with no cookie, no Authorization and no `?token=`, on the green host only, outside the
 * blocked/restricted regions, carrying the edge's verified-crawler header with the right secret,
 * on an allowlisted page, with a healthy settings bootstrap and `bot-html-edge-cache` on. That
 * render is already viewer-independent (anonymous, no region, no `verifiedBot`), and it is the one
 * the lean page reproduces. On top of the mark: the `bot-lean-render` flag, and a URL with no
 * query string (feed filters and storyline mode change what the page shows).
 *
 * The hook is the page's `getServerSideProps` (`createServerSideProps`'s `botLean`), after the
 * page's own resolver has run its prefetches: the lean page reads the SAME query cache the full
 * render would have been dehydrated from, so it cannot load different data or apply different
 * access rules. Writing the response there makes Next return before rendering
 * (`render.js`: `if (isResSent(res) && !isSSG) return RenderResult.EMPTY`).
 *
 * Fail-safe: a renderer that returns `null` (a case it does not reproduce, e.g. a gated or missing
 * image) or throws leaves the response untouched, and the page renders as it always has.
 */

/** Why a request that reached the lean hook got the normal render. */
export type BotLeanFallback =
  | 'query'
  | 'not-found'
  | 'gated'
  | 'unsupported'
  | 'error'
  | 'headers-sent';

type BotLeanEvent = 'render' | 'fallback';

export const BOT_LEAN_RENDER_METRIC = PROM_PREFIX + 'bot_lean_render_total';

function leanCounter(): Counter<'route' | 'event' | 'reason'> {
  return registerInstrumentationMetric(
    BOT_LEAN_RENDER_METRIC,
    () =>
      new client.Counter({
        name: BOT_LEAN_RENDER_METRIC,
        help:
          'Bot lean render: verified-crawler page requests answered with the lean HTML page ' +
          '(event=render), or handed to the normal render (event=fallback, with the reason)',
        labelNames: ['route', 'event', 'reason'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

export function recordBotLean(route: BotCacheRouteName, event: BotLeanEvent, reason = '') {
  try {
    leanCounter().inc({ route, event, reason });
  } catch {
    // Telemetry never fails the request.
  }
}

const readSwitch = () => {
  const on = isFliptSync(FLIPT_FEATURE_FLAGS.BOT_LEAN_RENDER);
  if (on === null && !getFliptClientSync()) void ensureFliptInitialized().catch(() => undefined);
  return on;
};
let flagGate = createCachedFlagGate(readSwitch);

/** Tests only: forget the cached switch read so the next request re-reads Flipt. */
export const resetBotLeanFlagGateForTests = () => {
  flagGate = createCachedFlagGate(readSwitch);
};

/**
 * Whether `req` may be answered by `route`'s lean renderer: `_app` marked it as that route's
 * bot-cache render, and the flag is on. Checked before anything else the hook does.
 */
export function isBotLeanCandidate(req: IncomingMessage, route: BotCacheRouteName) {
  const marked = (req as { [BOT_CACHE_REQ_KEY]?: string })[BOT_CACHE_REQ_KEY];
  if (marked !== route) return false;
  return flagGate();
}

/** What a lean renderer answers: the page, or why the normal render must answer instead. */
export type BotLeanResult = { html: string } | { fallback: Exclude<BotLeanFallback, 'error'> };

const shouldLogFailure = createLogThrottle(60_000);

function logBotLeanFailure(route: BotCacheRouteName, error: unknown) {
  if (!shouldLogFailure(`bot-lean-render:${route}`)) return;
  void import('~/server/logging/client')
    .then(({ logToAxiom, safeError }) =>
      logToAxiom({ ...safeError(error), name: 'bot-lean-render', type: 'warning', route })
    )
    .catch(() => undefined);
}

/**
 * Runs `render` for a candidate request and, when it answers with a page, sends it. `true` when
 * the response was sent (the caller must then return without rendering), `false` when the normal
 * render must answer. Never throws.
 */
export async function sendBotLeanRender(
  route: BotCacheRouteName,
  req: IncomingMessage,
  res: ServerResponse,
  render: () => Promise<BotLeanResult>
): Promise<boolean> {
  let result: BotLeanResult;
  try {
    if ((req.url ?? '').includes('?')) {
      recordBotLean(route, 'fallback', 'query');
      return false;
    }
    result = await render();
  } catch (error) {
    recordBotLean(route, 'fallback', 'error');
    logBotLeanFailure(route, error);
    return false;
  }
  if ('fallback' in result) {
    recordBotLean(route, 'fallback', result.fallback);
    return false;
  }
  if (res.headersSent) {
    recordBotLean(route, 'fallback', 'headers-sent');
    return false;
  }
  try {
    res.statusCode = 200;
    // The same `Cache-Control` and cookie rule as the full render this replaces.
    applyBotCachePrivateHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(result.html));
    res.end(result.html);
  } catch (error) {
    recordBotLean(route, 'fallback', 'error');
    logBotLeanFailure(route, error);
    // Nothing went out yet only when the headers were not sent; otherwise the response is spent.
    return res.headersSent;
  }
  recordBotLean(route, 'render');
  return true;
}

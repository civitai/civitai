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
 * JSON-LD, headings, the main text, the images and the links), without the React tree,
 * `trpcState` or `__NEXT_DATA__`.
 *
 * Reachable ONLY by a request `_app` marked as a bot-cache render (`~/server/bot-cache/bot-cache`):
 * a GET with no cookie, no Authorization and no `?token=`, on the green host only, outside the
 * blocked/restricted regions, carrying the edge's verified-crawler header with the right secret,
 * on an allowlisted page, with a healthy settings bootstrap and `bot-html-edge-cache` on. That
 * render is already viewer-independent (anonymous, no region, no `verifiedBot`), and it is the one
 * the lean page reproduces. On top of the mark: a query string with only the keys the route allows.
 *
 * Two flags, two modes:
 * - `bot-lean-render`: SERVE the lean page.
 * - `bot-lean-render-shadow` (and `bot-lean-render` off): render the lean page, serve the full one,
 *   and compare what a crawler reads from each once the full one has been written
 *   (`bot_lean_shadow_total`, plus a throttled log of the fields that differ). The gate before
 *   serving: shadow until it reports no differences.
 *
 * The hook is the page's `getServerSideProps` (`createServerSideProps`'s `botLean`), after the
 * page's own resolver has run its prefetches: the lean page reads the SAME query cache the full
 * render would have been dehydrated from, so it cannot load different data or apply different
 * access rules. The resolver's redirects and 404s happen before the hook, so they are the full
 * page's by construction. Writing the response there makes Next return before rendering
 * (`render.js`: `if (isResSent(res) && !isSSG) return RenderResult.EMPTY`).
 *
 * Fail-safe: a renderer that answers `fallback` (a case it does not reproduce) or throws leaves the
 * response untouched, and the page renders as it always has.
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
export const BOT_LEAN_SHADOW_METRIC = PROM_PREFIX + 'bot_lean_shadow_total';

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

type ShadowResult = 'match' | 'diff' | 'skipped' | 'error';

function shadowCounter(): Counter<'route' | 'result' | 'field'> {
  return registerInstrumentationMetric(
    BOT_LEAN_SHADOW_METRIC,
    () =>
      new client.Counter({
        name: BOT_LEAN_SHADOW_METRIC,
        help:
          'Bot lean render, shadow mode: lean pages compared with the full page served for the ' +
          'same request. result=match|diff|skipped|error; a diff counts once with field="" and ' +
          'once per differing field',
        labelNames: ['route', 'result', 'field'] as const,
        registers: [instrumentationRegistry],
      })
  );
}

export function recordBotLeanShadow(route: BotCacheRouteName, result: ShadowResult, field = '') {
  try {
    shadowCounter().inc({ route, result, field });
  } catch {
    // Telemetry never fails the request.
  }
}

// The key is read when the gate is, not at module load: suites that mock `~/server/flipt/client`
// without the enum still import this file through `server-side-helpers`.
function flagReader(flag: () => FLIPT_FEATURE_FLAGS) {
  return () => {
    const on = isFliptSync(flag());
    if (on === null && !getFliptClientSync()) void ensureFliptInitialized().catch(() => undefined);
    return on;
  };
}
const readServe = flagReader(() => FLIPT_FEATURE_FLAGS.BOT_LEAN_RENDER);
const readShadow = flagReader(() => FLIPT_FEATURE_FLAGS.BOT_LEAN_RENDER_SHADOW);
let serveGate = createCachedFlagGate(readServe);
let shadowGate = createCachedFlagGate(readShadow);

/** Tests only: forget the cached switch reads so the next request re-reads Flipt. */
export const resetBotLeanFlagGateForTests = () => {
  serveGate = createCachedFlagGate(readServe);
  shadowGate = createCachedFlagGate(readShadow);
};

export type BotLeanMode = 'serve' | 'shadow';

/**
 * What the lean hook does for `req`: `serve` or `shadow` when `_app` marked it as `route`'s
 * bot-cache render and the matching flag is on (serving wins), `null` otherwise.
 */
export function botLeanMode(req: IncomingMessage, route: BotCacheRouteName): BotLeanMode | null {
  const marked = (req as { [BOT_CACHE_REQ_KEY]?: string })[BOT_CACHE_REQ_KEY];
  if (marked !== route) return null;
  if (serveGate()) return 'serve';
  if (shadowGate()) return 'shadow';
  return null;
}

/** What a lean renderer answers: the page, or why the normal render must answer instead. */
export type BotLeanResult = { html: string } | { fallback: Exclude<BotLeanFallback, 'error'> };

const shouldLogFailure = createLogThrottle(60_000);

function logBotLean(route: BotCacheRouteName, name: string, data: Record<string, unknown>) {
  if (!shouldLogFailure(`${name}:${route}`)) return;
  void import('~/server/logging/client')
    .then(({ logToAxiom }) => logToAxiom({ ...data, name, type: 'warning', route }))
    .catch(() => undefined);
}

function logBotLeanFailure(route: BotCacheRouteName, error: unknown) {
  void import('~/server/logging/client')
    .then(({ safeError }) => logBotLean(route, 'bot-lean-render', { ...safeError(error) }))
    .catch(() => undefined);
}

/** `true` when every query key of `url` is in `allowed`. */
function queryAllowed(url: string | undefined, allowed: readonly string[]) {
  const search = (url ?? '').split('?')[1];
  if (!search) return true;
  return [...new URLSearchParams(search).keys()].every((key) => allowed.includes(key));
}

/** The lean page, or `null` (counted) when the normal render must answer. Never throws. */
async function renderLean(
  route: BotCacheRouteName,
  req: IncomingMessage,
  allowedQuery: readonly string[],
  render: () => Promise<BotLeanResult>
): Promise<string | null> {
  try {
    if (!queryAllowed(req.url, allowedQuery)) {
      recordBotLean(route, 'fallback', 'query');
      return null;
    }
    const result = await render();
    if ('fallback' in result) {
      recordBotLean(route, 'fallback', result.fallback);
      return null;
    }
    return result.html;
  } catch (error) {
    recordBotLean(route, 'fallback', 'error');
    logBotLeanFailure(route, error);
    return null;
  }
}

/**
 * Runs `render` for a request in `serve` mode and, when it answers with a page, sends it. `true`
 * when the response was sent (the caller must then return without rendering), `false` when the
 * normal render must answer. Never throws.
 */
export async function sendBotLeanRender(
  route: BotCacheRouteName,
  req: IncomingMessage,
  res: ServerResponse,
  allowedQuery: readonly string[],
  render: () => Promise<BotLeanResult>
): Promise<boolean> {
  const html = await renderLean(route, req, allowedQuery, render);
  if (html === null) return false;
  if (res.headersSent) {
    recordBotLean(route, 'fallback', 'headers-sent');
    return false;
  }
  try {
    res.statusCode = 200;
    // The same `Cache-Control` and cookie rule as the full render this replaces.
    applyBotCachePrivateHeaders(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.end(html);
  } catch (error) {
    recordBotLean(route, 'fallback', 'error');
    logBotLeanFailure(route, error);
    // Nothing went out yet only when the headers were not sent; otherwise the response is spent.
    return res.headersSent;
  }
  recordBotLean(route, 'render');
  return true;
}

type Chunk = string | Uint8Array | null | undefined | (() => void);
// A full page over this is not compared: its copy would hold memory until the response ends.
const MAX_SHADOW_BYTES = 4 * 1024 * 1024;
// Each differing field is logged with this much of each side.
const LOGGED_FIELD_CHARS = 2000;

/**
 * `shadow` mode: renders the lean page now and, once the full page this response carries has been
 * written, compares what a crawler reads from the two (`~/server/bot-cache/bot-lean-seo`). The
 * comparison runs after the response has ended, off its critical path, and never throws into it.
 * A full page that is not a 200 is `skipped`: the lean page is only ever a 200.
 */
export async function shadowBotLeanRender(
  route: BotCacheRouteName,
  req: IncomingMessage,
  res: ServerResponse,
  allowedQuery: readonly string[],
  render: () => Promise<BotLeanResult>
): Promise<void> {
  const lean = await renderLean(route, req, allowedQuery, render);
  if (lean === null) return;
  recordBotLean(route, 'render', 'shadow');
  try {
    captureFullPage(res, (full) => {
      setImmediate(() => void compareShadow(route, res, lean, full));
    });
  } catch (error) {
    recordBotLeanShadow(route, 'error');
    logBotLeanFailure(route, error);
  }
}

async function compareShadow(
  route: BotCacheRouteName,
  res: ServerResponse,
  lean: string,
  full: string | null
) {
  try {
    if (full === null || res.statusCode !== 200) return recordBotLeanShadow(route, 'skipped');
    const { diffSeo, seoOf } = await import('~/server/bot-cache/bot-lean-seo');
    const expected = seoOf(full);
    const actual = seoOf(lean);
    const fields = diffSeo(expected, actual);
    if (!fields.length) return recordBotLeanShadow(route, 'match');
    recordBotLeanShadow(route, 'diff');
    for (const field of fields) recordBotLeanShadow(route, 'diff', field);
    logBotLean(route, 'bot-lean-shadow-diff', {
      fields,
      ...Object.fromEntries(fields.map((f) => [f, describeField(expected[f], actual[f])])),
    });
  } catch (error) {
    recordBotLeanShadow(route, 'error');
    logBotLeanFailure(route, error);
  }
}

function describeField(full: unknown, lean: unknown) {
  return {
    full: JSON.stringify(full).slice(0, LOGGED_FIELD_CHARS),
    lean: JSON.stringify(lean).slice(0, LOGGED_FIELD_CHARS),
  };
}

/**
 * Keeps a copy of what Next writes for this response (`res.end(html)`, or `res.write` chunks;
 * `compress: false`, so these are the uncompressed bytes) and hands it to `done` once the response
 * has ended — `null` when it was too large to keep.
 */
function captureFullPage(res: ServerResponse, done: (html: string | null) => void) {
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
    if (size > MAX_SHADOW_BYTES) {
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
      done(overflow ? null : Buffer.concat(chunks).toString('utf8'));
    }
    return result;
  } as unknown as ServerResponse['end'];
}

import client from 'prom-client';
import type { NextApiRequest } from 'next';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';

// ---------------------------------------------------------------------------
// tRPC batch-width observability + the over-cap request marker
// ---------------------------------------------------------------------------
//
// WHY: tRPC batching lets ONE HTTP request fan out to N procedure calls, which decouples
// request rate from actual work — every request-counting control (rate limits, connection
// caps, per-request timeouts) sees 1 where the server does N. `TRPC_MAX_BATCH_SIZE` bounds N;
// this histogram is how we know whether that bound is in the right place, because it observes
// EVERY batch width unconditionally — including widths above the cap, which are rejected and
// would otherwise leave no trace at all.
//
// HOT PATH: this codebase is main-thread-CPU sensitive (Redis/Prisma OTEL spans were removed
// for exactly this reason). Per request this costs one `charCodeAt` scan of the already-parsed
// `trpc` query segment plus one histogram observation — deliberately NO `split(',')`, which
// would allocate an N-element array of substrings on every batched request just to read its
// length.
//
// 🔴 INVARIANT: import this module ONLY from the request webpack graph (API routes / pages).
// prom-client keeps a per-graph default registry and `/api/metrics` scrapes the request
// graph's; if an `instrumentation.*` import ever pulled this into the instrumentation graph
// first, the histogram would register into the wrong registry and silently stop being scraped
// (the PR #2451 class of bug — see the same note in `http-errors.ts`). Today the only
// production importer is `src/pages/api/trpc/[trpc].ts`. Test-only imports are fine: they run
// outside webpack entirely.

const NAME = 'civitai_app_trpc_batch_width';

/** Histogram buckets. Dense below the cap (where legitimate traffic lives), sparse above it
 *  (where only rejected traffic lands) — 30 is a bucket edge so `le="30"` reads directly as
 *  "accepted", and 25 sits just under it so the approach to the cap is visible before anything
 *  is actually clipped. */
export const TRPC_BATCH_WIDTH_BUCKETS = [1, 2, 3, 5, 10, 20, 25, 30, 50, 100, 150, 250];

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTrpcBatchWidthHistogram: client.Histogram<string> | undefined;
}

// Pin on globalThis so HMR re-evals / a second request-graph eval reuse the one instance
// instead of throwing prom-client's duplicate-registration error (same trap documented for
// `httpErrorCounter` in http-errors.ts and `instrumentationRegistry` in prom/client.ts). The
// `??` short-circuits BEFORE `new client.Histogram`, so the constructor runs once.
export const trpcBatchWidthHistogram: client.Histogram<string> =
  globalThis.__civitaiTrpcBatchWidthHistogram ??
  (globalThis.__civitaiTrpcBatchWidthHistogram = new client.Histogram({
    name: NAME,
    help:
      'Distribution of tRPC BATCH WIDTH (procedure calls carried by one HTTP request), observed ' +
      'on every /api/trpc request before the request is handled. Non-batched requests (no ' +
      '`?batch=1`) are observed as width 1. `over_limit="true"` means the width exceeded ' +
      'TRPC_MAX_BATCH_SIZE and tRPC rejected the whole request with a 400 before createContext ' +
      'ran — those requests resolve ZERO procedures, so they appear here and nowhere else. ' +
      '`client` is a hard-bounded 3-value label (web|other|none) derived from the x-client ' +
      'header; it is caller-supplied and is NOT authentication — treat `web` as "claims to be ' +
      'the browser bundle", not as proof.',
    buckets: TRPC_BATCH_WIDTH_BUCKETS,
    labelNames: ['over_limit', 'client'],
  }));

/** Every value `client` can take. Enumerated so the series can be seeded (below). */
const CLIENT_LABELS = ['web', 'other', 'none'] as const;

/**
 * Initialise all 6 (over_limit x client) series to zero.
 *
 * 🔴 A labelled histogram emits NOTHING for a label set until its first observation, so
 * `over_limit="true"` would read `no data` until the first over-cap request ever seen by this
 * pod — indistinguishable from "the cap is not wired up" or "this module never loaded", on the
 * exact series whose job is to be read as evidence. Seeding makes a genuine zero observable as
 * a zero. (Same reasoning, and the same fix, as the generation-model-substitution counters
 * seeded from `src/pages/api/metrics.ts`.)
 */
function seedTrpcBatchWidthSeries(): void {
  try {
    for (const over_limit of ['true', 'false']) {
      for (const client of CLIENT_LABELS) trpcBatchWidthHistogram.zero({ over_limit, client });
    }
  } catch {
    /* never throw from telemetry */
  }
}

seedTrpcBatchWidthSeries();

const COMMA = 44; // ','.charCodeAt(0)

/**
 * Count `,` separators without allocating. `split(',')` would build an N-element array of
 * substrings per batched request purely to read `.length`; this reads the same number off the
 * string already in memory.
 */
function countSeparators(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === COMMA) n++;
  return n;
}

/**
 * Next merges repeated query params into an array. tRPC reads `batch` via
 * `URLSearchParams.get()`, which returns the FIRST occurrence — mirror that so a duplicated
 * `?batch=1&batch=0` is classified the same way the server actually treats it.
 */
function firstValue(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

/**
 * Batch width for a tRPC request, computed the way tRPC computes it: a request is a batch call
 * only when `?batch=1`, and its width is `path.split(',').length`.
 *
 * The path comes from `req.query.trpc` — the `[trpc]` dynamic segment. Next hands it back as a
 * string, or as an array when the route resolves to multiple segments (the adapter joins those
 * with `/`, so separators in every element count).
 *
 * ⚠️ LOWER BOUND, not an exact mirror: tRPC applies its own `decodeURIComponent` to the path
 * before splitting, on top of the decode Next already did. A doubly-encoded comma (`%252C`)
 * therefore yields one more call server-side than this counts. The CAP is unaffected — it is
 * enforced by tRPC itself, after its own decode — so this only means the histogram can
 * under-report a deliberately double-encoded path. It never over-reports.
 */
export function computeBatchWidth(req: Pick<NextApiRequest, 'query'>): number {
  const query = req?.query;
  if (!query) return 1;
  if (firstValue(query.batch) !== '1') return 1;

  const trpc = query.trpc;
  if (typeof trpc === 'string') return countSeparators(trpc) + 1;
  if (Array.isArray(trpc)) {
    let separators = 0;
    for (const segment of trpc) separators += countSeparators(segment);
    return separators + 1;
  }
  return 1;
}

/**
 * Hard-bounded client label. Three values, forever: `web` (what the browser bundle sends — see
 * the `x-client` header in `src/utils/trpc.ts`), `other` (any other value), `none` (absent).
 * The header is caller-supplied, so this MUST collapse unknown values rather than pass them
 * through — otherwise one crafted header per request blows up label cardinality.
 */
export function boundedClientLabel(raw: string | string[] | undefined): string {
  const v = firstValue(raw);
  if (v === undefined) return 'none';
  return v === 'web' ? 'web' : 'other';
}

/**
 * Observe one request's batch width and return it. Never throws — a telemetry failure must not
 * break a request. On an internal failure it returns 1, which is the SAFE direction: 1 can
 * never be mistaken for an over-cap request, so a broken metric degrades to "log this error
 * normally" rather than to "silently suppress a log".
 */
export function observeTrpcBatchWidth(req: NextApiRequest): number {
  try {
    const width = computeBatchWidth(req);
    trpcBatchWidthHistogram.observe(
      {
        over_limit: width > TRPC_MAX_BATCH_SIZE ? 'true' : 'false',
        client: boundedClientLabel(req?.headers?.['x-client']),
      },
      width
    );
    return width;
  } catch {
    /* never throw from telemetry */
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Over-cap request marker
// ---------------------------------------------------------------------------
//
// A rejected batch still reaches the adapter's `onError`, where the default path pays a stack
// capture, a `JSON.stringify(input)` and a log write. Under sustained abuse that is a log storm
// on the exact requests the cap exists to make cheap — and it would be paid on the event loop.
//
// The marker is DELIBERATELY a request-scoped flag we set ourselves rather than a match on
// tRPC's error message ("Batch call exceeds maximum size"). Matching library prose would make
// the skip silently stop working — reopening the storm — on any upstream reword. This cannot
// drift: the same code that measures the width sets the flag.
//
// Correctness relies on the ordering verified in `@trpc/server`'s `resolveResponse`: the
// over-cap throw happens in `getRequestInfo`, BEFORE `ctxManager.create()`, so an over-cap
// request produces exactly ONE `onError` call and it is always the cap rejection. The `req`
// handed to `onError` is the original Node request object (the node-http adapter re-attaches
// `opts.req`), which is why a property stamped here is visible there.
//
// `Symbol.for` (not `Symbol()`) so the marker survives the module being evaluated in more than
// one graph — a second copy of this module would otherwise mint a different symbol and the
// skip would silently never fire.
const OVER_CAP_MARKER = Symbol.for('civitai.trpc.batchOverCap');

/** Mark a request as having exceeded `TRPC_MAX_BATCH_SIZE`. Never throws. */
export function markTrpcBatchOverCap(req: unknown): void {
  try {
    (req as Record<symbol, unknown>)[OVER_CAP_MARKER] = true;
  } catch {
    /* never throw from telemetry */
  }
}

/** Whether this request was marked over-cap by `markTrpcBatchOverCap`. Never throws. */
export function isTrpcBatchOverCap(req: unknown): boolean {
  try {
    return (req as Record<symbol, unknown> | undefined)?.[OVER_CAP_MARKER] === true;
  } catch {
    return false;
  }
}

/**
 * The whole per-request entry point: observe the batch width, and mark the request when it
 * exceeds the cap. Returns the width.
 *
 * 🔴 The `width > cap` branch lives HERE rather than in the route on purpose. A Next API page
 * cannot be loaded in a unit test (its module graph pulls `appRouter` + `createContext`), so a
 * branch written inline in the route is only ever pinnable by reading the source — and a
 * mutation that deleted the marking survived a full green suite exactly that way. The marking
 * is what arms the log-storm skip, so losing it fails SILENTLY: the cap still works, the metric
 * still moves, and every rejected batch quietly starts paying a stack capture + Axiom ingest
 * again. Keeping the branch in this module makes it behaviourally testable, and leaves the
 * route with one unconditional call.
 */
export function instrumentTrpcBatchRequest(req: NextApiRequest): number {
  const width = observeTrpcBatchWidth(req);
  if (width > TRPC_MAX_BATCH_SIZE) markTrpcBatchOverCap(req);
  return width;
}

/**
 * Whether this `onError` invocation is a batch-cap rejection whose Axiom ingest should be
 * skipped.
 *
 * NARROW BY CONSTRUCTION — both conjuncts are load-bearing:
 *  - the request must carry OUR marker, so this can only ever match a request whose width we
 *    measured above the cap. A blanket `code === 'BAD_REQUEST'` skip would hide real
 *    client-fault bugs (failed zod validation, malformed payloads) across the entire API.
 *  - the code must still be `BAD_REQUEST`, so if a marked request somehow produced some other
 *    error it is logged normally.
 *
 * Deliberately NOT a match on tRPC's error message ("Batch call exceeds maximum size"): library
 * prose is not an interface, and a reword would silently reopen the log storm this prevents.
 *
 * Exported raw so tests can drive it directly with both controls (same reason
 * `b2PutMetricsMiddleware` is exported in `b2-put.metrics.ts`).
 */
export function shouldSkipBatchCapLog(req: unknown, error: { code?: string } | undefined): boolean {
  return error?.code === 'BAD_REQUEST' && isTrpcBatchOverCap(req);
}

/** Test-only: clear the histogram between cases, back to the seeded (present-at-zero) state
 *  production starts in — `reset()` alone would drop the seeded series and leave the test
 *  environment observing something production never does. */
export function __resetTrpcBatchMetricsForTest(): void {
  trpcBatchWidthHistogram.reset();
  seedTrpcBatchWidthSeries();
}

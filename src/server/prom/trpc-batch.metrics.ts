import client from 'prom-client';
import type { NextApiRequest } from 'next';
import { getTrpcMaxBatchSize } from '~/server/trpc/batch-cap';

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
 *  (where only rejected traffic lands) — the DEFAULT cap is a bucket edge so `le="<cap>"` reads
 *  directly as "accepted", and 25 sits just under it so the approach to the cap is visible
 *  before anything is actually clipped. Pinned by a test: dropping the cap's own edge silently
 *  destroys that reading. (Buckets are static, so an env override of `TRPC_MAX_BATCH_SIZE`
 *  moves the effective cap OFF a bucket edge — the `over_limit` label stays exact, only the
 *  `le=` reading becomes approximate.) */
export const TRPC_BATCH_WIDTH_BUCKETS = [1, 2, 3, 5, 10, 20, 25, 30, 50, 100, 150, 250];

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTrpcBatchWidthHistogram: client.Histogram<string> | undefined;
}

// Pin on globalThis so HMR re-evals / a second request-graph eval reuse the one instance
// instead of throwing prom-client's duplicate-registration error (same trap documented for
// `httpErrorCounter` in http-errors.ts and `instrumentationRegistry` in prom/client.ts). The
// `??` short-circuits BEFORE `new client.Histogram`, so the constructor runs once.
//
// `existingHistogram` is captured so the seeding below can tell "this module evaluation CREATED
// the histogram" from "it found one that has been counting". See `seedTrpcBatchWidthSeries`.
const existingHistogram = globalThis.__civitaiTrpcBatchWidthHistogram;

export const trpcBatchWidthHistogram: client.Histogram<string> =
  existingHistogram ??
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
 * a zero. (Same reasoning as the generation-model-substitution counters, but NOT the same
 * mechanism — see below.)
 *
 * 🔴 THIS IS DESTRUCTIVE AND MUST ONLY RUN ON A FRESHLY-CREATED HISTOGRAM.
 * `generation-model-substitution.metrics.ts` seeds with `counter.inc({...}, 0)`, which is a
 * genuine no-op on a series that already exists. `Histogram.zero(labels)` is not: prom-client
 * implements it as an unconditional (re)initialisation of that label set's buckets, sum and
 * count, so calling it on a live series WIPES everything accumulated under those labels. This
 * module is pinned on `globalThis` precisely because it can be evaluated more than once (HMR,
 * a second request-graph eval) — an unconditional module-scope seed would therefore reset all
 * six series on the second evaluation, and the resulting hole would look exactly like the
 * "the cap never fired" reading the seeding exists to prevent.
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

// Only when THIS evaluation constructed the histogram. A re-evaluation reuses the pinned
// instance, whose series are already present (and possibly non-zero) — re-seeding would erase
// them. `__resetTrpcBatchMetricsForTest` is the deliberate exception: it resets on purpose.
if (!existingHistogram) seedTrpcBatchWidthSeries();

const COMMA = 44; // ','.charCodeAt(0)

/**
 * Count `,` separators without allocating an intermediate array. `split(',')` builds an
 * N-element array of substrings per batched request purely to read `.length`; this reads the
 * same number off the string already in memory.
 *
 * ⚠️ NOT a throughput win — the opposite, measured: at width 200 this scan takes ~2266ns
 * against `split(',').length`'s ~1885ns, because V8's `split` is native. The reason to keep it
 * is ALLOCATION, not speed: no garbage per request on a main-thread-CPU-sensitive path. Both
 * numbers are noise next to the request they measure; do not "optimise" either way on this
 * comment alone.
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
 * break a request.
 *
 * 🔴 THE CATCH'S RETURN VALUE IS A SAFETY PROPERTY, NOT A PLACEHOLDER. It returns 1, which is
 * under any positive cap, so a failed measurement can never mark a request over-cap and a
 * broken metric degrades to "log this error normally". A value ABOVE the cap here would invert
 * that: every request whose measurement threw would be marked over-cap, arming the `onError`
 * skip and suppressing the Axiom ingest for every `BAD_REQUEST` in the process — the log-storm
 * guard turned into a blanket log-suppressor, silently. Pinned by a test that forces the throw.
 */
export function observeTrpcBatchWidth(req: NextApiRequest): number {
  try {
    const width = computeBatchWidth(req);
    trpcBatchWidthHistogram.observe(
      {
        // The EFFECTIVE cap, not the compiled-in constant: the route builds `maxBatchSize` from
        // the same `getTrpcMaxBatchSize()`, so `over_limit` labels exactly the requests tRPC
        // will reject. Reading the constant here instead would mislabel every request between
        // the two values whenever the env var overrides it — and, worse, would arm the
        // `onError` log-skip on requests tRPC ACCEPTED, silently suppressing genuine
        // BAD_REQUESTs from their procedures.
        over_limit: width > getTrpcMaxBatchSize() ? 'true' : 'false',
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

/** Mark a request as having exceeded the effective batch cap. Never throws. */
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
 * 🔴 The `width > cap` branch lives HERE rather than in the route on purpose: it keeps the route
 * to one unconditional call, and it is what makes the branch drivable in isolation. Losing the
 * marking fails SILENTLY — the cap still works, the metric still moves, and every rejected batch
 * quietly resumes paying a stack capture + Axiom ingest — so it needs a behavioural pin, and a
 * mutation that deleted it did once survive a fully green suite.
 *
 * (The route itself IS unit-loadable, contrary to an earlier note here: mocking `~/server/routers`,
 * `~/server/createContext` and the adapter is enough, and `trpc-handler-wiring.test.ts` does
 * exactly that to assert the route calls this before delegating. Both pins are kept — this one
 * covers the branch, that one covers the wiring.)
 *
 * Uses the EFFECTIVE cap so the marker cannot disagree with what tRPC enforced; see the
 * `over_limit` note in `observeTrpcBatchWidth`.
 */
export function instrumentTrpcBatchRequest(req: NextApiRequest): number {
  const width = observeTrpcBatchWidth(req);
  if (width > getTrpcMaxBatchSize()) markTrpcBatchOverCap(req);
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

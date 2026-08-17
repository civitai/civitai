/**
 * tRPC request-batching limits — the SINGLE source of truth for both ends of the wire.
 *
 * Imported by the browser batch link (`src/utils/trpc.ts` → `maxItems`) AND, as the DEFAULT for
 * the server cap, by `src/env/server-schema.ts` (`TRPC_MAX_BATCH_SIZE`, resolved through
 * `src/server/trpc/batch-cap.ts` → `maxBatchSize`). Keep it dependency-free so it can be pulled
 * into the client bundle without dragging server code with it.
 *
 * ── WHY A CAP ───────────────────────────────────────────────────────────────────────────────
 * tRPC batching lets ONE HTTP request carry N procedure calls (`?batch=1` + a comma-separated
 * path list). That decouples request rate from actual work: a caller who sends the same number
 * of HTTP requests can multiply the server-side procedure calls — and therefore CPU, DB and
 * Redis load — by whatever N it chooses. Rate limits, connection limits and per-request
 * timeouts all count requests, so none of them see the multiplier. Without a cap, N is
 * unbounded and attacker-chosen.
 *
 * The client-side `maxURLLength` on the batch link is NOT a limit on this: it only shapes how
 * OUR browser bundle groups its own operations. Anything speaking HTTP builds the URL itself.
 */

/**
 * Maximum procedure calls accepted in a single batched tRPC request.
 *
 * This value is BOTH the browser batch link's `maxItems` and the DEFAULT of the server's
 * `TRPC_MAX_BATCH_SIZE` env var. The server's effective cap is whatever
 * `getTrpcMaxBatchSize()` resolves (`src/server/trpc/batch-cap.ts`); the client's is always this
 * constant, because a browser bundle cannot read server env. That asymmetry is deliberate and
 * its safe direction is documented on `getTrpcMaxBatchSize`.
 *
 * tRPC rejects an over-cap batch with `BAD_REQUEST` (HTTP 400) inside `getRequestInfo`, which
 * runs BEFORE `createContext` — no session lookup, no DB/Redis round-trip, no procedure
 * resolution, so the N-procedure amplification the cap exists to stop never happens.
 * `src/server/__tests__/trpc-batch-cap.test.ts` pins that by asserting zero procedures resolve
 * and zero contexts are created on a rejected request, for GET and for POST.
 *
 * ⚠️ Rejection is cheap, not free, and it is method-dependent. On a GET the request costs URL
 * parsing and nothing else. On a POST (legitimate here — `allowMethodOverride: true` lets a
 * query carry its input in the body) Next parses the body up to the route's 17mb limit BEFORE
 * the handler runs, and the adapter re-stringifies it before `resolveResponse`, so an over-cap
 * POST pays that regardless of the cap. Measured: an 8MB over-cap POST batch cost ~27.5ms of
 * body parsing plus an 8MB re-stringify, and still resolved 0 procedures and created 0
 * contexts. The cap removes the per-procedure amplification; it does not make a large POST free.
 *
 * ── WHY 30 ──────────────────────────────────────────────────────────────────────────────────
 * Measured from Cloudflare `httpRequestsAdaptiveGroups` — the FULL request population, not a
 * sampled or filtered access log — over 2026-08-15T10:00Z → 2026-08-16T10:00Z, ~2.87M tRPC
 * requests. In that window first-party tRPC request paths max out at 400 characters (99.66% are
 * ≤100), 95.84% of requests are batch width 1 and 99.84% are width ≤10. The over-wide batches
 * that appear in production come from automated non-browser clients, at widths well above any
 * first-party shape.
 *
 * 🔴 THE HONEST LIMIT OF THAT EVIDENCE: `trpcBatching` is currently `availability: ['mod']`
 * (`src/server/services/feature-flags.service.ts`), so the measured population is largely
 * UNBATCHED. The width distribution above is therefore not a forecast of what first-party
 * traffic will emit once the flag ramps, and 30 is not "2x the widest thing users send" — it is
 * a number chosen above every observed first-party shape and well below the automated ones.
 *
 * What actually makes the cap safe for first-party traffic is structural, not distributional:
 *  - the pre-existing `maxURLLength: 2083` on the batch link already binds the named fan-out
 *    shapes at 22–29 operations, i.e. below this cap, before `maxItems` is consulted at all;
 *  - `maxItems` makes the link's dataloader SPLIT a wider fan-out across several ≤cap requests
 *    rather than reject it, so no first-party request can be built above the cap at any width.
 * `civitai_app_trpc_batch_width` (`src/server/prom/trpc-batch.metrics.ts`) observes every batch
 * width unconditionally, so this number can be re-derived from live data — and MUST be
 * re-derived from post-ramp data before anyone reads the pre-ramp distribution as a bound.
 */
export const TRPC_MAX_BATCH_SIZE = 30;

/**
 * Widest batch the FIRST-PARTY app was observed to emit in production when this cap was
 * introduced.
 *
 * Not read at runtime — it exists so the cap carries its own justification, and so a future
 * tightening of `TRPC_MAX_BATCH_SIZE` below real traffic fails CI (see
 * `src/utils/__tests__/trpc-batching.test.ts`) instead of failing in production.
 *
 * 🔴 Read it as a FLOOR, not a bound. It was measured while `trpcBatching` was mod-gated (see
 * the caveat above), so it describes a nearly-unbatched population — the same window puts
 * 99.84% of all tRPC requests at width ≤10. Update it if a wider first-party batch is measured;
 * the histogram is the instrument.
 */
export const OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH = 14;

/**
 * tRPC request-batching limits — the SINGLE source of truth for both ends of the wire.
 *
 * Imported by the server adapter (`src/pages/api/trpc/[trpc].ts` → `maxBatchSize`) AND by the
 * browser batch link (`src/utils/trpc.ts` → `maxItems`). Keep it dependency-free so it can be
 * pulled into the client bundle without dragging server code with it.
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
 * tRPC rejects an over-cap batch with `BAD_REQUEST` (HTTP 400) inside `getRequestInfo`, which
 * runs BEFORE `createContext` — so a rejected batch costs URL parsing and nothing else: no
 * session lookup, no DB/Redis round-trip, no procedure resolution. That ordering is the entire
 * cost argument for the cap, and `src/server/__tests__/trpc-batch-cap.test.ts` pins it by
 * asserting zero procedures resolve on a rejected request.
 *
 * ── WHY 30 ──────────────────────────────────────────────────────────────────────────────────
 * Measured against production batch widths: real first-party traffic tops out around width 14
 * (see `OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH`), and the observed distribution is completely
 * empty between 15 and 120. 30 therefore sits in a genuinely unused gap with ~2x headroom over
 * anything the app has been seen to send, while still rejecting the wide automated batches that
 * motivated the cap. The empty gap is what makes the number safe to pick: there is no
 * legitimate traffic anywhere near it to clip.
 *
 * `civitai_app_trpc_batch_width` (see `src/server/prom/trpc-batch.metrics.ts`) observes every
 * batch width unconditionally, so this number can be re-derived from live data rather than
 * re-argued. Lower it only after checking that histogram.
 */
export const TRPC_MAX_BATCH_SIZE = 30;

/**
 * Widest batch the FIRST-PARTY app has been observed to emit in production.
 *
 * Not read at runtime — it exists so the cap carries its own justification, and so a future
 * tightening of `TRPC_MAX_BATCH_SIZE` below real traffic fails CI (see
 * `src/utils/__tests__/trpc-batching.test.ts`) instead of failing in production. Update it if a
 * wider first-party batch is ever measured; the histogram above is the instrument.
 */
export const OBSERVED_MAX_FIRST_PARTY_BATCH_WIDTH = 14;

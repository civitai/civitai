import * as z from 'zod';

/**
 * Most model ids `model.getActiveSales` accepts in one call.
 *
 * 🔴 THE BOUND IS REAL WORK, NOT AN ARBITRARY NUMBER, so raising it is not the way to fix a
 * caller that overflows it. `getActiveSalesForModels` resolves every id through the per-id cache,
 * whose `packed.mGet` is `Promise.all(keys.map(get))` — one Redis GET per id, plus a write-back
 * SET per miss. What this constant does is bound the WIDTH of one call: it keeps a single request's
 * fan-out proportional to a page of cards rather than to an accumulated feed. It is a per-request
 * bound and nothing more: how many requests arrive is a separate question, which this number does
 * not answer and should not be read as answering. The cap stays; callers chunk.
 *
 * ⚠️ The SQL half is NOT what this is protecting. Measured on the read replica, the planner
 * post-filters `mv."modelId" = ANY(...)` over a small scan: execution time is flat from 100 to
 * 5000 ids and only planning grows (~1 ms per 1000). So do not cite "the query" as the reason —
 * the per-id Redis fan-out and the per-id work on a single-threaded pod are the reason.
 */
export const MODEL_SALE_IDS_PER_QUERY = 500;

/**
 * How many ids a card surface puts in ONE request. Deliberately NOT the cap above.
 *
 * Matched to the BROWSE feed's page size (`getAllModelsSchema`'s `limit` maxes and defaults at
 * 100), because the trailing partial chunk re-keys on every page and therefore re-asks every id it
 * already knew. At a chunk of C and a page of P the ids asked per distinct id is (C/P + 1)/2 —
 * 3.0x at C=500/P=100, and 1.0x at C=P, for the SAME number of requests per page.
 *
 * ⚠️ There is no single page size to align to: the search page pages at 50 and then shrinks each
 * page through hidden-preference filtering, and the browse handler can accumulate past 100 when an
 * early iteration comes back short. So this is the value that makes the DOMINANT surface exact and
 * every other one much better (1.5x at P=50, against 5.5x had the chunk stayed at the cap) — not a
 * number that makes the amplification 1.0x everywhere.
 *
 * It also keeps a request well under `MAX_GET_INPUT_LENGTH` in `~/utils/trpc` (measured with
 * 7-digit ids: ~809 raw chars against 2500, where 500 ids is ~4009), so it stays a GET instead of
 * being rewritten to a body-carrying POST — which is the live benefit, on the link ALL traffic
 * uses. It clears `URL_INPUT_BUDGET` (~1040 encoded against 1800) as well, but that only matters
 * once request batching ramps past its current mod-only audience, so do not read it as today's
 * justification.
 */
export const MODEL_SALE_IDS_PER_REQUEST = 100;

/** Input `model.getActiveSales` validates with. Exported so a caller can be tested against it. */
export const getActiveSalesSchema = z.object({
  ids: z.number().array().max(MODEL_SALE_IDS_PER_QUERY),
});

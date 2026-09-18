import * as z from 'zod';

/**
 * Most model ids `model.getActiveSales` accepts in one call.
 *
 * 🔴 THE BOUND IS REAL WORK, NOT AN ARBITRARY NUMBER, so raising it is not the way to fix a
 * caller that overflows it. `getActiveSalesForModels` resolves every id through the per-id cache,
 * whose `packed.mGet` is `Promise.all(keys.map(get))` — one Redis GET per id, plus a write-back
 * SET per miss. The procedure is PUBLIC, so the length of this array is the only thing standing
 * between an anonymous caller and that fan-out. The cap stays; callers chunk.
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
 * Matched to the feed's page size (`getAllModelsSchema`'s `limit` maxes and defaults at 100),
 * because the trailing partial chunk re-keys on every page and therefore re-asks every id it
 * already knew. At a chunk of C and a page of P the ids asked per distinct id is (C/P + 1)/2 —
 * 3.0x at C=500/P=100, and 1.0x at C=P, for the SAME number of requests per page. Chunking at the
 * page size means every page produces exactly one complete chunk whose key never changes again.
 *
 * It also keeps a request under both of `~/utils/trpc`'s wire thresholds (measured with 7-digit
 * ids: 100 ids is ~809 raw / ~1040 encoded chars, against `MAX_GET_INPUT_LENGTH` 2500 and
 * `URL_INPUT_BUDGET` 1800), so it stays a batchable GET instead of becoming an unbatchable POST.
 */
export const MODEL_SALE_IDS_PER_REQUEST = 100;

/** Input `model.getActiveSales` validates with. Exported so a caller can be tested against it. */
export const getActiveSalesSchema = z.object({
  ids: z.number().array().max(MODEL_SALE_IDS_PER_QUERY),
});

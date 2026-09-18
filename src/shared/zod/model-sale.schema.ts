import * as z from 'zod';

/**
 * Most model ids `model.getActiveSales` accepts in one call — and therefore the size a surface
 * chunks its cards into before asking.
 *
 * 🔴 THE BOUND IS REAL WORK, NOT AN ARBITRARY NUMBER, so raising it is not the way to fix a
 * caller that overflows it. `getActiveSalesForModels` resolves every id through the per-id cache,
 * whose `packed.mGet` decomposes into one Redis GET per id on a cluster (no MGET across slots),
 * and every id that misses lands in a raw `IN (…)` across a five-table join on the read replica.
 * The procedure is PUBLIC, so the length of this array is the only thing standing between an
 * anonymous caller and that work. The cap stays; callers chunk.
 *
 * Lives here rather than inline in the router so the client chunker and the server's validation
 * read the SAME number. Split across two files they drift, and the drift is invisible until it
 * surfaces as a BAD_REQUEST on every call from the surface that grew past the older value.
 */
export const MODEL_SALE_IDS_PER_QUERY = 500;

/** Input `model.getActiveSales` validates with. Exported so a caller can be tested against it. */
export const getActiveSalesSchema = z.object({
  ids: z.number().array().max(MODEL_SALE_IDS_PER_QUERY),
});

import { parseSaleLimitOverrides, SALE_LIMITS_KEY, type SaleLimitOverrides } from '@civitai/buzz';
import { dbRead } from '$lib/server/db';

// The sale limits an operator can move without a deploy, from the `sale-limits` KeyValue row. The
// constants in @civitai/buzz are the defaults; this only overrides what the row actually carries, so an
// absent or partial row leaves every unmentioned limit at its default.
//
// Enforcement is Studio-only (this is the authoring app). The main app reads the same row through the
// same parser only to describe the floor on the creator journey.

/**
 * Sale limit overrides for this request. Returns `{}` when the row is missing, unreadable, or malformed —
 * every caller then gets the compiled defaults, which is what the helpers in @civitai/buzz do with an
 * absent argument anyway.
 *
 * A read failure must not fail the page: the limits it feeds are enforced again inside the scheduling
 * transaction, and a models list that 500s because one config row is unreadable is worse than a list
 * showing the default allowance.
 */
export async function getSaleLimitOverrides(): Promise<SaleLimitOverrides> {
  try {
    const row = await dbRead
      .selectFrom('KeyValue')
      .select('value')
      .where('key', '=', SALE_LIMITS_KEY)
      .executeTakeFirst();
    if (!row) return {};
    return parseSaleLimitOverrides(row.value);
  } catch {
    return {};
  }
}

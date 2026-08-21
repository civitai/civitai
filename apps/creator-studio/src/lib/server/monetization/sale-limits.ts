import { z } from 'zod';
import { SALE_LIMITS_KEY, type SaleLimitOverrides } from '@civitai/buzz';
import { dbRead } from '$lib/server/db';

// The sale limits an operator can move without a deploy, from the `sale-limits` KeyValue row. The
// constants in @civitai/buzz are the defaults; this only overrides what the row actually carries, so an
// absent or partial row leaves every unmentioned limit at its default.
//
// Enforcement is Studio-only (this is the authoring app), so reading the row is ours. It is in KeyValue
// rather than a constant so a pricing page can state the same numbers instead of restating them.

// `KeyValue.value` is a Json column, so anything is representable — including shapes that would widen a
// limit by accident. Every field is validated and a bad one is DROPPED rather than coerced: falling back
// to the compiled default is the safe direction for a spend limit, and `.catch(undefined)` per field
// means one malformed entry can't discard the others.
const positiveInt = z.number().int().positive();

const overridesSchema = z
  .object({
    saleDaysByTier: z
      .record(z.string(), positiveInt)
      .catch(undefined as never)
      .optional(),
    minCreatorScore: z
      .number()
      .int()
      .nonnegative()
      .catch(undefined as never)
      .optional(),
    maxLeadDays: positiveInt.catch(undefined as never).optional(),
  })
  .catch({});

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
    return overridesSchema.parse(row.value) as SaleLimitOverrides;
  } catch {
    return {};
  }
}

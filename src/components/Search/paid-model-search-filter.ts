/**
 * The "hide paid models" clause for the models search index.
 *
 * 🔴 `NOT <attr> = true`, never `<attr> = false`. A negation matches documents that LACK the
 * attribute; an equality does not. Only GATED models are backfilled with `hasActivePaidAccess`, so
 * `= false` would hide every model whose document has not been rewritten since the field shipped —
 * which is nearly all of them, and the failure would look like "hide paid returns almost nothing".
 *
 * Measured on the live index against `cannotPromote`, which has the same sparse shape:
 * `cannotPromote EXISTS` 1,853 · `cannotPromote = true` 1,115 · `NOT cannotPromote = true` >=100,000.
 * If negation skipped absent documents that last number could not have exceeded 738.
 *
 * `poi != true` and `minor != true` two lines above the call site say the same thing a different
 * way and are equally correct. This spelling is kept because it is the one the numbers above were
 * measured with.
 */
export const HIDE_PAID_MODELS_FILTER = 'NOT hasActivePaidAccess = true';

/**
 * Returns the clause when it should apply, and `null` when it should not — `null` because
 * `buildBrowsingLevelFilters` drops undefined-ish entries and Meilisearch rejects a bare `()`.
 *
 * A function rather than an inline ternary at the call site so the flag gate and the default are
 * testable: both were previously unreachable from any test, and deleting the whole clause from the
 * page left every suite green.
 */
export function paidModelsSearchFilterClause(enabled: boolean, hidePaid: boolean) {
  return enabled && hidePaid ? HIDE_PAID_MODELS_FILTER : null;
}

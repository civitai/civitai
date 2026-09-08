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
 */
export const HIDE_PAID_MODELS_FILTER = 'NOT hasActivePaidAccess = true';

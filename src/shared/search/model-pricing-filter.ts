import { ModelVersionPricingSignal } from '@civitai/buzz';
import type { FilterClause } from '~/shared/utils/meili-filter';
import { eq, exists, not, or } from '~/shared/utils/meili-filter';

export const PRICING_FILTER_FIELD = 'versions.pricing';

export type ModelPricingFilter = {
  /** Exclude versions you must buy access to before generating. */
  hidePaid?: boolean;
};

/**
 * 🔴 A POSITIVE match on `GenerationFree`, never `NOT ... = PayToGenerate`.
 *
 * Meilisearch flattens `versions[]`, so a negation matches only models where NO version is gated —
 * hiding a model with one paid version and five free ones, which the product keeps visible.
 *
 * 🔴 The `NOT ... EXISTS` half is what lets the backfill cover only the ~3K GATED models instead of
 * every document: an absent attribute means "not rewritten since the field shipped", and those must
 * show rather than vanish. It makes the filter fail OPEN — a gated model the backfill misses is shown
 * under "Hide paid" — which is the trade that bought a 3K sweep over a 713K one. Re-running
 * `queue-paid-models-reindex` is the reconciler.
 *
 * Drop this half once every document carries the field (the index rewrites continuously, so that
 * arrives on its own); until then removing it silently hides every un-rewritten model.
 */
export function modelPricingFilterClause({ hidePaid }: ModelPricingFilter): FilterClause | null {
  if (!hidePaid) return null;
  return or(
    eq(PRICING_FILTER_FIELD, ModelVersionPricingSignal.GenerationFree),
    not(exists(PRICING_FILTER_FIELD))
  );
}

export const hasPricingFilter = ({ hidePaid }: ModelPricingFilter): boolean => !!hidePaid;

export const pricingFilterKey = ({ hidePaid }: ModelPricingFilter): string => `${!!hidePaid}`;

/**
 * The search filter matched the MODEL, and flattening means the version that matched is not
 * necessarily the one a caller is about to show.
 */
export function versionSatisfiesPricingFilter(
  pricing: ModelVersionPricingSignal[] | undefined,
  { hidePaid }: ModelPricingFilter
): boolean {
  if (!hidePaid) return true;
  // Matches the clause's `NOT ... EXISTS` half: no signals means the document predates the field,
  // and the query showed its model — so the card must not disagree and skip past it.
  if (!pricing?.length) return true;
  return pricing.includes(ModelVersionPricingSignal.GenerationFree);
}

/**
 * 🔴 NOT the complement of `versionSatisfiesPricingFilter`, and the gap is deliberate. A document
 * predating `versions.pricing` carries no signals, so it PASSES the filter and is NOT badged here —
 * both defer to the backfill rather than guessing, in the one direction that cannot mislabel a price.
 * Keep both derivations in this file so the asymmetry stays one decision.
 */
export const versionIsPaidToGenerate = (
  pricing: ModelVersionPricingSignal[] | undefined
): boolean => !!pricing?.includes(ModelVersionPricingSignal.PayToGenerate);

// What a model version costs the person using it, reduced to flags the search index can filter on.
//
// Licensing fees are deliberately NOT tracked here. "Paid" on Civitai means a paid-access gate, both
// in the product and in every existing filter (`getModelsRaw`'s hidePaid, `hasActivePaidAccess`); a
// per-generation fee is a separate concept that no surface filters on today.

import type { ModelVersionTerms } from './paid-access';
import { isFreeGeneration, isPaidAccessActive } from './paid-access';

/**
 * Members of `versions.pricing` on the models search index.
 *
 * APPEND-ONLY: the ordinals are stored in every search document, so re-meaning one costs a backfill.
 * Ordinals rather than bit values — Meilisearch has no bitwise filter inside an array.
 */
export enum ModelVersionPricingSignal {
  /** No live gate of either kind. */
  Free = 0,
  PayToGenerate = 1,
  PayToDownload = 2,
  /**
   * Generation is not gated. Says nothing about the download tier. Looks redundant with `Free` and
   * is not: it is the only member a filter can match on — see `modelPricingFilterClause`.
   */
  GenerationFree = 3,
}

export type ModelVersionPricing = {
  free: boolean;
  payToGenerate: boolean;
  payToDownload: boolean;
};

export type ModelVersionPricingInput = {
  paidAccess?: { endsAt: Date | null; terms: ModelVersionTerms } | null;
};

export function resolveModelVersionPricing({
  paidAccess,
}: ModelVersionPricingInput): ModelVersionPricing {
  const gated = !!paidAccess && isPaidAccessActive(paidAccess);
  const terms = paidAccess?.terms;

  // Deliberately NARROWER than `generationOpenToNonBuyers`, the predicate that actually gates
  // generation: that counts a trial allowance as open (~41% of live gates — 1,974 of 4,815,
  // 2026-09-23), and trials are PER VIEWER while a search document is shared.
  // Accepted consequence: "Hide paid" also hides a gated version the viewer could still generate with
  // for free — so no UI may claim purchase is required right now.
  // A missing `generation` grant is bundled with the download, and unreadable terms price as paid:
  // failing open would index a paywalled version as free.
  const payToGenerate = gated && (!terms || !isFreeGeneration(terms));
  const payToDownload = gated && terms?.download != null;

  return { free: !payToGenerate && !payToDownload, payToGenerate, payToDownload };
}

/** 🔴 Never empty: `hidePaid` matches a member positively, so a version with no member is unfilterable. */
export function toPricingSignals(pricing: ModelVersionPricing): ModelVersionPricingSignal[] {
  const signals: ModelVersionPricingSignal[] = [];
  if (pricing.free) signals.push(ModelVersionPricingSignal.Free);
  if (pricing.payToGenerate) signals.push(ModelVersionPricingSignal.PayToGenerate);
  else signals.push(ModelVersionPricingSignal.GenerationFree);
  if (pricing.payToDownload) signals.push(ModelVersionPricingSignal.PayToDownload);
  return signals;
}

export const modelVersionPricingSignals = (
  input: ModelVersionPricingInput
): ModelVersionPricingSignal[] => toPricingSignals(resolveModelVersionPricing(input));

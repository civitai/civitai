import type { BlockAttributionScope } from '~/server/schema/blocks/attribution.schema';

/**
 * Revenue-share rate card for buzz purchases originated inside an App
 * Block. Rate cards are NEVER mutated in place — to change the share
 * percentages, define a NEW exported constant with a new `version`
 * string and update `ACTIVE_RATE_CARD` to point at it. Past
 * `block_buzz_attribution` rows stamp `rate_card_version` at write time
 * and pay out under their own snapshot for the lifetime of the row.
 *
 * If we need to retroactively adjust a row (e.g. leadership-approved
 * one-off bonus), introduce a `block_buzz_attribution_adjustment` audit
 * table — DO NOT recompute the live row.
 */
export type RateCard = {
  version: string;
  /**
   * Publisher cut per scope, expressed as a percentage of
   * (gross_cents - provider_fee_cents). 0 = no share. The platform
   * keeps whatever the publisher doesn't.
   */
  publisherSharePctByScope: Record<BlockAttributionScope, number>;
  /**
   * Apps owned by these userIds always pay 0% to publisher — internal
   * civitai apps where the "share" is meaningless because the same
   * legal entity owns both sides of the transaction.
   */
  internalAppOwnerUserIds: number[];
  effectiveFrom: string; // ISO date — informational, not enforced
};

// ---------------------------------------------------------------
// PLACEHOLDER PERCENTAGES — confirm with monetization leadership
// before announcing publicly. See the "Numbers worth getting from
// leadership" section of
// claudedocs/app-blocks-buzz-attribution-handoff-2026-05-25.md.
//
// Open items to confirm:
//   - Default publisher cut (20%? 30%? Hard to undo upward once announced).
//   - Whether viewer_personal is boosted vs per_model_install (this
//     card assumes yes — user discovery is rewarded).
//   - Whether platform_default pays 0 or some token amount.
//   - Whether to apply different rates by buzz type (yellow vs blue).
//   - Whether to cap monthly per-app earnings.
//
// Until those are signed off, treat any v1 attribution payout as a
// soft-launch — do NOT enable the bulk payout job in production
// without explicit approval.
// ---------------------------------------------------------------
export const RATE_CARD_V1: RateCard = {
  version: 'v1',
  publisherSharePctByScope: {
    // Publisher chose to install the block on their own model — earns
    // a share.
    per_model_install: 20,
    // Same as above, just broader (every model the publisher owns).
    publisher_all_my_models: 20,
    // User chose this app for their own viewing — slightly higher to
    // reward app discovery / viral acquisition.
    viewer_personal: 25,
    // Mod-promoted on the platform's behalf — publisher already earns
    // via reach/install funnel, no extra share.
    platform_default: 0,
  },
  internalAppOwnerUserIds: [
    // Populate with civitai team userIds before going live. Empty for
    // now — none of the load-bearing paths read this list yet, but the
    // service plumbing checks it.
  ],
  effectiveFrom: '2026-05-25',
};

export const ACTIVE_RATE_CARD: RateCard = RATE_CARD_V1;

/**
 * Result of running a (gross, fee, scope) tuple through the active rate
 * card. The sum of the three `*_cents` fields equals `usd_amount_cents`
 * — the migration's CHECK constraint enforces this at write time.
 */
export type RateCardSplit = {
  rateCardVersion: string;
  appOwnerShareCents: number;
  platformShareCents: number;
  providerFeeCents: number;
};

/**
 * Compute the publisher / platform / provider-fee split for a single
 * buzz attribution row.
 *
 * Order of operations matters: provider fee is taken off the top, then
 * the publisher share is a percentage of the NET (gross - fee), and
 * the platform gets the remainder. This keeps the publisher's share
 * computable from a single `share_pct` number without the publisher
 * needing to understand the provider's fee schedule.
 *
 * Special cases:
 *   - `isSelfPurchase` (purchaser == publisher) → publisher share is
 *     zeroed regardless of scope. The caller is responsible for also
 *     setting status='voided', voided_reason='self_purchase' on the
 *     row so it never enters the payout pipeline.
 *   - `appOwnerUserId` ∈ `internalAppOwnerUserIds` → publisher share is
 *     zeroed regardless of scope. Row is still pending/confirmed but
 *     pays nothing to the publisher.
 *
 * Rounding: the publisher share is rounded with Math.floor so the
 * platform absorbs any sub-cent remainder. Never the other way around
 * — the publisher should never receive a fractional cent the platform
 * didn't actually collect.
 */
export function computeRateCardSplit({
  rateCard = ACTIVE_RATE_CARD,
  grossCents,
  providerFeeCents,
  scope,
  isSelfPurchase,
  appOwnerUserId,
}: {
  rateCard?: RateCard;
  grossCents: number;
  providerFeeCents: number;
  scope: BlockAttributionScope;
  isSelfPurchase: boolean;
  appOwnerUserId: number;
}): RateCardSplit {
  // Defensive: never let a negative number drift through the CHECK
  // constraint. A provider fee greater than gross is theoretically
  // possible (refunds, dispute fees) and should be treated as
  // "publisher gets nothing, platform absorbs the loss" — write a
  // zero-share row and let the operator notice via the audit log.
  const safeGross = Math.max(0, Math.floor(grossCents));
  const safeFee = Math.max(0, Math.min(safeGross, Math.floor(providerFeeCents)));
  const net = safeGross - safeFee;

  const isInternal = rateCard.internalAppOwnerUserIds.includes(appOwnerUserId);
  const sharePct =
    isSelfPurchase || isInternal ? 0 : rateCard.publisherSharePctByScope[scope] ?? 0;
  const appOwnerShareCents = Math.floor((net * sharePct) / 100);
  const platformShareCents = net - appOwnerShareCents;

  return {
    rateCardVersion: rateCard.version,
    appOwnerShareCents,
    platformShareCents,
    providerFeeCents: safeFee,
  };
}

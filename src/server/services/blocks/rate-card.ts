import type { BlockAttributionScope } from '~/server/schema/blocks/attribution.schema';
import { isPayoutEligibleBuzz } from '~/server/utils/buzz-helpers';

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
   * W3 flow A — buzz SPEND attribution (author bounty).
   *
   * The percentage of a block-initiated generation's USD value paid to
   * the app author as a PLATFORM-FUNDED BOUNTY (NOT a cut of the viewer's
   * spend — see the accounting note below and the migration). One flat
   * rate for spend (no per-scope dimension): a spend has no install
   * scope the way a purchase does — it's just "this app caused a
   * generation". PLACEHOLDER pending monetization sign-off.
   */
  spendSharePct: number;
  /**
   * W3 flow C — MEMBERSHIP / subscription attribution.
   *
   * The percentage of a block-initiated membership payment's NET (gross -
   * provider fee) paid to the app author, applied per PAID INVOICE. Unlike
   * a one-shot Buzz purchase, a subscription bills recurringly: by the
   * renewals-pay policy each paid invoice (subscription_create AND
   * subscription_cycle) is tracked.
   *
   * ⚠️ NOT applied at attribution-write time. As of the TRACK-ONLY rework
   * (#2629), this percentage is computed at PAYOUT time as a backpay over
   * `status='tracked'` rows, NOT stamped onto the row when it's written.
   * One flat rate for subscription (no install-scope dimension): a
   * membership purchase resolves to the single `subscription` scope.
   * PLACEHOLDER pending monetization sign-off.
   */
  subscriptionSharePct: number;
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
// Three cards defined: V1 (the original spec placeholder, 20/20/25/0),
// V2 (the recommended starting point, 15/15/25/0) and V3 (V2 + the
// new W10 page scope `viewer_global` at 0%). Rate cards are immutable
// — past attribution rows stamp their version at write time and pay
// out under it forever. To change percentages, add a V4, leave
// V1/V2/V3 in place for the rows that referenced them.
//
// `viewer_global` (W10 page purchase, flow B) is a PLACEHOLDER 0% on
// every card — no historical row ever used it (the scope is net-new
// in this PR), so adding it at 0% to V1/V2 is behavior-preserving for
// their stamped rows. Page revenue is largely platform-counterfactual,
// so 0% is the v1 launch number; a real publisher share for pages
// needs monetization-leadership sign-off and lands as a future card.
//
// Open items still to confirm:
//   - Final cuts. V2 starts lower; raising is politically easier
//     than lowering. Default publisher cut floor is the most
//     load-bearing decision.
//   - Whether viewer_personal stays boosted vs per_model_install
//     (both cards say yes — user discovery is rewarded).
//   - Whether platform_default pays 0 or some token amount.
//   - Whether to apply different rates by buzz type (yellow vs blue).
//   - Whether to cap monthly per-app earnings.
//
// Until those are signed off, treat any attribution payout as a
// soft-launch — do NOT enable the bulk payout job in production
// without explicit approval.
// ---------------------------------------------------------------
export const RATE_CARD_V1: RateCard = {
  version: 'v1',
  publisherSharePctByScope: {
    per_model_install: 20,
    publisher_all_my_models: 20,
    viewer_personal: 25,
    platform_default: 0,
    // Net-new scope (W10 page purchase). No V1 row ever used it; 0% is
    // behavior-preserving for this card's stamped rows.
    viewer_global: 0,
  },
  // Net-new spend dimension (W3 flow A). 0% on V1 is behavior-preserving:
  // no spend row was ever stamped under V1 (the spend flow is net-new),
  // and V1 is not the active card.
  spendSharePct: 0,
  // Net-new subscription dimension (W3 flow C). 0% — behavior-preserving:
  // no subscription row was ever stamped under V1 (flow C is net-new), and
  // V1 is not the active card.
  subscriptionSharePct: 0,
  internalAppOwnerUserIds: [],
  effectiveFrom: '2026-05-25',
};

/**
 * V2 — recommended starting card.
 *
 * Reasoning:
 *  - per_model_install / publisher_all_my_models lowered from 20% to
 *    15%. Most conversions on the user's OWN model are counterfactual
 *    (user was already on civitai and would have bought buzz anyway);
 *    rewarding the publisher modestly recognizes their effort to
 *    install without overpaying for revenue civitai would have
 *    captured regardless.
 *  - viewer_personal kept at 25%. This is the most incremental scope:
 *    user actively chose a third-party app, drove discovery /
 *    acquisition. Worth rewarding highest as a developer-ecosystem
 *    signal.
 *  - platform_default kept at 0%. Mod-promoted; publisher already
 *    earns via reach / install funnel.
 *  - Start lower; raise via V3 if traction / publisher feedback
 *    warrants. Easier than lowering after a public announcement.
 */
export const RATE_CARD_V2: RateCard = {
  version: 'v2',
  publisherSharePctByScope: {
    // Publisher chose to install on their own model — modest cut to
    // acknowledge their effort.
    per_model_install: 15,
    // Same as above, just broader (every model the publisher owns).
    publisher_all_my_models: 15,
    // User chose this app for their own viewing — highest cut to
    // reward app discovery / viral acquisition.
    viewer_personal: 25,
    // Mod-promoted on the platform's behalf — publisher already earns
    // via reach / install funnel, no extra share.
    platform_default: 0,
    // Net-new scope (W10 page purchase). No V2 row ever used it; 0% is
    // behavior-preserving for this card's stamped rows.
    viewer_global: 0,
  },
  // Net-new spend dimension (W3 flow A). 0% — behavior-preserving (no V2
  // spend row ever existed; V2 is not the active card).
  spendSharePct: 0,
  // Net-new subscription dimension (W3 flow C). 0% — behavior-preserving
  // (no V2 subscription row ever existed; V2 is not the active card).
  subscriptionSharePct: 0,
  internalAppOwnerUserIds: [
    // Populate with civitai team userIds before going live. Empty for
    // now — none of the load-bearing paths read this list yet, but the
    // service plumbing checks it. Belt-and-suspenders: platform_default
    // is already 0% so the dominant team-app path doesn't need this
    // list, but per_model_install / publisher_all_my_models for a
    // team-owned app would.
  ],
  effectiveFrom: '2026-05-26',
};

/**
 * V3 — adds the W10 page-purchase scope (`viewer_global`, flow B).
 *
 * Carries V2's percentages UNCHANGED (15/15/25/0) and adds
 * `viewer_global: 0`. This is the first card emitted for page purchases:
 * a Buzz purchase made inside a full-page app is TRACKED (a
 * block_buzz_attribution row is written) but pays the author 0% for now —
 * page revenue is largely platform-counterfactual, and shipping at 0%
 * (rather than not tracking at all) means the row history exists so a
 * later, signed-off non-zero card can be applied going forward without
 * losing the pre-decision purchase trail.
 *
 * PLACEHOLDER — a real publisher share for pages needs monetization
 * leadership sign-off. When that lands, add a V4 with the agreed % and
 * leave V3 in place for the rows stamped under it (cards are immutable).
 *
 * `spendSharePct` is carried at 0% on V3 — V3 predates the spend flow and
 * stamped only purchase rows. The spend flow (W3 flow A) ships under V4.
 * `subscriptionSharePct` is likewise 0% — flow C ships under V5.
 */
export const RATE_CARD_V3: RateCard = {
  version: 'v3',
  publisherSharePctByScope: {
    // Carried from V2 verbatim — do NOT change these here; a percentage
    // change is a new card, not an edit to V3.
    per_model_install: 15,
    publisher_all_my_models: 15,
    viewer_personal: 25,
    platform_default: 0,
    // W10 page purchase — placeholder 0%, raise via a future card after
    // monetization sign-off.
    viewer_global: 0,
  },
  spendSharePct: 0,
  subscriptionSharePct: 0,
  internalAppOwnerUserIds: [
    // Same as V2 — populate with civitai team userIds before going live.
  ],
  effectiveFrom: '2026-06-18',
};

/**
 * V4 — adds the W3 flow A buzz-SPEND author bounty (`spendSharePct`).
 *
 * Carries V3's purchase percentages UNCHANGED (15/15/25/0/0) and sets
 * `spendSharePct` to the FIRST non-zero spend rate. This is the first
 * card emitted for the spend flow: a block-initiated generation that
 * burns the viewer's own Buzz now accrues an author bounty.
 *
 * ⚠️ PLACEHOLDER RATE — `spendSharePct: 5` is a CONSERVATIVE DEFAULT
 *    chosen pending monetization sign-off (Zach's call: ship a documented
 *    conservative number, not a guessed-final one). Raising is politically
 *    easier than lowering after a public announcement, so this starts low.
 *
 * ACCOUNTING MODEL — PLATFORM-FUNDED BOUNTY, not a cut of the spend:
 *    The viewer burns 100% of their Buzz on the generation (that is
 *    platform revenue — the viewer paid civitai for compute). The author
 *    bounty is a SEPARATE platform expense paid ON TOP, sized as
 *    `spendSharePct` % of the spend's USD value. It is a marketing /
 *    ecosystem cost, NOT a slice carved out of the viewer's money. There
 *    is therefore NO three-way conservation invariant for spend rows (the
 *    block_spend_attribution table omits the purchase table's
 *    fee+platform+author=gross CHECK). The conservation/ledger invariant
 *    that DOES hold: author_share = floor(grossValueCents * spendSharePct
 *    / 100), 0 ≤ author_share ≤ grossValueCents, and author_share = 0 on
 *    self-spend / internal-owner.
 *
 *    LEDGER IMPLICATION FOR SIGN-OFF: every paid spend bounty is net-new
 *    platform spend (it does not reduce platform revenue on the
 *    generation). At spendSharePct=N% and a daily block-spend volume of
 *    $X USD-equivalent, the platform's bounty liability is ~$X·N%/day.
 *    This is the number monetization must sign off on, NOT a revenue
 *    split. Cap exposure with the existing BLOCK_BUZZ_CAP_PER_DAY (bounds
 *    per-user daily spend) and the per-app earnings cap (unimplemented
 *    placeholder) before widening beyond mods.
 *
 * When the signed-off rate lands, add a V5 with the agreed % and leave V4
 * in place for the rows stamped under it (cards are immutable).
 */
export const RATE_CARD_V4: RateCard = {
  version: 'v4',
  publisherSharePctByScope: {
    // Carried from V3 verbatim — a percentage change is a new card.
    per_model_install: 15,
    publisher_all_my_models: 15,
    viewer_personal: 25,
    platform_default: 0,
    viewer_global: 0,
  },
  // PLACEHOLDER 5% platform-funded bounty — see the doc block above.
  spendSharePct: 5,
  // Net-new subscription dimension (W3 flow C). 0% on V4 — behavior-
  // preserving (V4 stamped only spend + purchase rows; flow C ships under
  // V5). A percentage change is a new card, not an edit to V4.
  subscriptionSharePct: 0,
  internalAppOwnerUserIds: [
    // Same as V3 — populate with civitai team userIds before going live.
  ],
  effectiveFrom: '2026-06-18',
};

/**
 * V5 — adds the W3 flow C MEMBERSHIP / subscription rev-share
 * (`subscriptionSharePct`).
 *
 * Carries V4's purchase percentages (15/15/25/0/0) AND its spend bounty
 * (5%) UNCHANGED, and DEFINES `subscriptionSharePct: 15` as the PLACEHOLDER
 * subscription rate.
 *
 * ⚠️ NOT APPLIED AT ATTRIBUTION-WRITE TIME. As of the TRACK-ONLY rework
 *    (PR #2629), `recordSubscriptionAttribution` does NOT call
 *    `computeSubscriptionShare` and does NOT stamp this percentage onto the
 *    row. Membership attribution rows are written `status='tracked'` with
 *    `app_owner_share_cents = 0`, `subscription_share_pct = 0`, and
 *    `rate_card_version = 'unrated'` — they record the EVENT + the money
 *    BASIS (gross + provider_fee) only. The author share is deferred to
 *    PAYOUT TIME: the future payout rail (Slice 4) reads `status='tracked'`
 *    rows and computes `author_share = net × <signed-off subscriptionSharePct>`
 *    as a clean retroactive BACKPAY, then transitions them to a
 *    computed/confirmed state. Because the rows carry gross+fee, the
 *    backpay computation is exact.
 *
 *    WHY: committing a share at this placeholder 15% before monetization
 *    sign-off would lock those rows to the placeholder rate (the
 *    immutability doctrine pays each row out under its STAMPED snapshot
 *    forever). Recording the gross/fee now and applying the signed-off rate
 *    later removes that placeholder-rate liability from the ledger while
 *    preserving the full purchase trail.
 *
 * ⚠️ PLACEHOLDER RATE — `subscriptionSharePct: 15` mirrors the
 *    publisher-purchase floor (15%) as a CONSERVATIVE STARTING DEFAULT
 *    pending monetization sign-off. Recurring revenue is structurally
 *    different (LTV-weighted, renewals compound), so leadership may choose
 *    a DIFFERENT number than one-shot purchase. It is the rate the eventual
 *    payout/backpay WILL apply, pending sign-off — not a final figure.
 *
 * ACCOUNTING MODEL (at payout, NOT at write) — same THREE-WAY split as a
 *    Buzz purchase (NOT the platform-funded bounty model of spend): a
 *    membership payment is a real card transaction. provider_fee comes off
 *    the top, the author share is `subscriptionSharePct` % of the NET
 *    (gross - fee), the platform keeps the remainder. At write time the
 *    tracked row sets `platform_share = net` and `author_share = 0`, so the
 *    conservation invariant (fee + platform + author = gross) still holds;
 *    the backpay re-splits net into platform/author at payout.
 *
 * RENEWALS-PAY POLICY (⚠️ FLAGGED for sign-off, scope §C/E#3): one
 *    attribution row per PAID invoice means renewals (subscription_cycle)
 *    are tracked just like the initial purchase (subscription_create), so
 *    the backpay will pay each renewal. This is the default. A
 *    "first-invoice-only" policy is a service-level gate (write only on
 *    subscription_create) — no card change.
 *
 * When the signed-off rate lands, add a V6 with the agreed % and leave V5
 * in place (cards are immutable). `computeSubscriptionShare` below remains
 * for the payout-time backpay to call against the signed-off card.
 */
export const RATE_CARD_V5: RateCard = {
  version: 'v5',
  publisherSharePctByScope: {
    // Carried from V4 verbatim — a percentage change is a new card.
    per_model_install: 15,
    publisher_all_my_models: 15,
    viewer_personal: 25,
    platform_default: 0,
    viewer_global: 0,
  },
  // Carried from V4 verbatim.
  spendSharePct: 5,
  // PLACEHOLDER 15% subscription rev-share — see the doc block above.
  subscriptionSharePct: 15,
  internalAppOwnerUserIds: [
    // Same as V4 — populate with civitai team userIds before going live.
  ],
  effectiveFrom: '2026-06-18',
};

export const ACTIVE_RATE_CARD: RateCard = RATE_CARD_V5;

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

/**
 * Result of running a (grossValueCents, owner) tuple through the active
 * card's SPEND dimension (W3 flow A). Unlike RateCardSplit there is no
 * platform-share / provider-fee field: the author bounty is platform-
 * funded and paid ON TOP of the spend, not carved out of it, so there is
 * nothing to "split". See RATE_CARD_V4's accounting note.
 */
export type SpendShareResult = {
  rateCardVersion: string;
  spendSharePct: number;
  appOwnerShareCents: number;
};

/**
 * Compute the author bounty for a single block-initiated Buzz SPEND.
 *
 * `grossValueCents` is the USD value of the Buzz the generation burned
 * (buzzDollarRatio 1000 Buzz = $1 = 100 cents — the caller converts). The
 * bounty is `spendSharePct` % of that value, floored so the platform
 * never over-pays a fractional cent.
 *
 * Special cases (mirror computeRateCardSplit):
 *   - `isSelfSpend` (spender == app owner) → 0 bounty. The author
 *     generating in their own app earns nothing; the caller sets
 *     status='voided', voided_reason='self_spend' so the row never enters
 *     the payout pipeline.
 *   - `appOwnerUserId` ∈ `internalAppOwnerUserIds` → 0 bounty (internal
 *     civitai app — same legal entity on both sides).
 *   - `buzzType` NOT payout-eligible → 0 bounty. ⚠️ LOAD-BEARING
 *     PAYOUT-SAFETY GATE (App Blocks Sybil / payout review). Block
 *     currencies were widened to on-site PARITY (blue/green/yellow); to
 *     keep that widening from EVER becoming platform-funded farming, only
 *     PAID Buzz (`isPayoutEligibleBuzz` → green + yellow) can accrue an
 *     author bounty. The FREE type — blue (free generation Buzz) — is
 *     EXCLUDED here so a Sybil ring spending free Buzz mints ZERO
 *     platform-funded bounty. (green is PAID — product confirmed
 *     2026-06-30: "green buzz is paid, only blue is free".)
 *     `buzzType` defaults to the legacy 'yellow' (the pre-widening
 *     currency) so existing/untyped callers are behavior-preserved.
 *     Whoever enables the #2605 payout rail MUST keep this gate — it is the
 *     single boundary that decouples spendable-currency parity from
 *     payout-eligibility. See `isPayoutEligibleBuzz` in buzz-helpers.ts.
 *
 * Invariants (also enforced by the migration's CHECKs):
 *   - appOwnerShareCents >= 0
 *   - appOwnerShareCents <= grossValueCents (a bounty can never exceed
 *     the revenue it rewards — a runaway rate is a bug)
 */
export function computeSpendShare({
  rateCard = ACTIVE_RATE_CARD,
  grossValueCents,
  isSelfSpend,
  appOwnerUserId,
  buzzType = 'yellow',
}: {
  rateCard?: RateCard;
  grossValueCents: number;
  isSelfSpend: boolean;
  appOwnerUserId: number;
  /**
   * The account type the spend was drained from. Defaults to 'yellow' (the
   * pre-parity currency) so legacy callers are unchanged. The free type
   * (blue) is non-payout-eligible and zeroes the bounty. See the PAYOUT-SAFETY
   * note above.
   */
  buzzType?: string;
}): SpendShareResult {
  const safeGross = Math.max(0, Math.floor(grossValueCents));

  const isInternal = rateCard.internalAppOwnerUserIds.includes(appOwnerUserId);
  // PAYOUT-SAFETY: the free Buzz type (blue) is never payout-eligible.
  const isPayoutIneligible = !isPayoutEligibleBuzz(buzzType);
  const sharePct =
    isSelfSpend || isInternal || isPayoutIneligible ? 0 : rateCard.spendSharePct ?? 0;
  // Floor so the platform never over-pays a sub-cent remainder, then clamp
  // to the gross as a defensive ceiling (the bounty can never exceed the
  // spend's USD value — matches the migration's _share_le_gross_check).
  const appOwnerShareCents = Math.min(safeGross, Math.floor((safeGross * sharePct) / 100));

  return {
    rateCardVersion: rateCard.version,
    spendSharePct: sharePct,
    appOwnerShareCents,
  };
}

/**
 * Result of running a (gross, fee, owner) tuple through the active card's
 * SUBSCRIPTION dimension (W3 flow C). A membership payment is a real card
 * transaction split three ways (like a Buzz purchase), so this carries the
 * same fee / platform / author fields as RateCardSplit. The sum of the
 * three `*_cents` fields equals the gross — the migration's CHECK enforces
 * this for entry_type='charge' rows.
 */
export type SubscriptionShareResult = {
  rateCardVersion: string;
  subscriptionSharePct: number;
  appOwnerShareCents: number;
  platformShareCents: number;
  providerFeeCents: number;
};

/**
 * Compute the publisher / platform / provider-fee split for a single
 * block-initiated MEMBERSHIP payment (one paid invoice).
 *
 * ⚠️ PAYOUT-TIME ONLY. This is NOT called by `recordSubscriptionAttribution`
 * anymore (the TRACK-ONLY rework, #2629). Membership rows are written
 * `status='tracked'` with a 0 share and no stamped rate. This function is
 * retained for the future payout rail (Slice 4) to call against the
 * signed-off card, computing each tracked row's author share as a backpay.
 *
 * Same order of operations as computeRateCardSplit: provider fee off the
 * top, the author share is `subscriptionSharePct` % of the NET
 * (gross - fee), the platform gets the remainder. The three-way sum always
 * equals the gross by construction (the platform absorbs the sub-cent floor
 * remainder), so the migration's conservation CHECK holds.
 *
 * Special cases (mirror computeRateCardSplit):
 *   - `isSelfPurchase` (subscriber == app owner) → author share 0. Caller
 *     sets status='voided', voided_reason='self_purchase'.
 *   - `appOwnerUserId` ∈ `internalAppOwnerUserIds` → author share 0
 *     (internal civitai app — same legal entity on both sides).
 *
 * Defensive: a provider fee greater than gross (refund/dispute edge) is
 * clamped to gross → author 0, platform 0 — the platform absorbs the loss.
 */
export function computeSubscriptionShare({
  rateCard = ACTIVE_RATE_CARD,
  grossCents,
  providerFeeCents,
  isSelfPurchase,
  appOwnerUserId,
}: {
  rateCard?: RateCard;
  grossCents: number;
  providerFeeCents: number;
  isSelfPurchase: boolean;
  appOwnerUserId: number;
}): SubscriptionShareResult {
  const safeGross = Math.max(0, Math.floor(grossCents));
  const safeFee = Math.max(0, Math.min(safeGross, Math.floor(providerFeeCents)));
  const net = safeGross - safeFee;

  const isInternal = rateCard.internalAppOwnerUserIds.includes(appOwnerUserId);
  const sharePct =
    isSelfPurchase || isInternal ? 0 : rateCard.subscriptionSharePct ?? 0;
  const appOwnerShareCents = Math.floor((net * sharePct) / 100);
  const platformShareCents = net - appOwnerShareCents;

  return {
    rateCardVersion: rateCard.version,
    subscriptionSharePct: sharePct,
    appOwnerShareCents,
    platformShareCents,
    providerFeeCents: safeFee,
  };
}

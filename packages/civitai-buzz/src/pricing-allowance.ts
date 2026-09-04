// The monthly pricing allowance — what a membership actually governs — and the eligibility floor in
// front of it. Pure: no DB, no framework. Both the main app and the creator-studio spoke enforce these
// rules themselves, because the spoke's fee and gate writes are direct SQL that never reaches the main
// app's service layer. What each app owns is the two QUERIES and the ordering; everything a query does
// not need lives here, so a threshold or a message cannot drift between two doors into the same data.

import { finiteOrNull } from './licensing-fee';
import {
  CAP_TIERS,
  CAP_TIER_LABELS,
  MONETIZATION_MIN_CREATOR_SCORE,
  nextCapTier,
  type CapTier,
} from './paid-access';

/**
 * How many NEW prices a tier may apply per calendar month. This is the only thing membership governs
 * about monetization — the price ceilings are the same for everyone.
 *
 * A "price" is a licensing fee or a PERMANENT paid-access gate. A timed early-access window costs
 * nothing (it prices itself out when the window closes), and neither does editing a price already set:
 * the allowance counts entities newly priced, one slot per entity however many kinds of price it carries.
 */
export const MONTHLY_PRICING_ALLOWANCE_BY_TIER: Record<string, number> = {
  free: 3,
  // Legacy paid tier — allowance matches bronze.
  founder: 10,
  bronze: 10,
  silver: 25,
  gold: Infinity,
};

/**
 * New prices `tier` may apply this calendar month. An unknown or lapsed tier gets the FREE allowance
 * rather than 0: losing a membership must never take away the ability to price anything at all, and it
 * can never affect a price that is already set.
 */
export function monthlyPricingAllowance(tier: string | null | undefined): number {
  return (
    (tier ? MONTHLY_PRICING_ALLOWANCE_BY_TIER[tier] : undefined) ??
    MONTHLY_PRICING_ALLOWANCE_BY_TIER.free
  );
}

/**
 * Whether an entity already carries a price, and so is exempt from both rules. The single definition of
 * that question — a timed early-access window is not a price.
 */
export function isAlreadyPriced({
  licensingFee,
  hasPermanentGate,
}: {
  licensingFee?: number | null;
  hasPermanentGate?: boolean;
}): boolean {
  return (licensingFee ?? 0) > 0 || !!hasPermanentGate;
}

/**
 * A write that takes the LAST price off an entity — the only shape that can return a slot. Editing a
 * price is not it, and neither is clearing one of two prices: a fee removed from a version that still
 * carries a permanent gate leaves it priced.
 *
 * Whether the slot actually comes back is each app's own transaction check; this is only the rule half.
 */
export function clearsLastPrice({
  wasPriced,
  willBePriced,
}: {
  wasPriced: boolean;
  willBePriced: boolean;
}): boolean {
  return wasPriced && !willBePriced;
}

/** The window every slot count is scoped to. */
export function pricingMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Takes a count so a bulk write is refused as a whole rather than half-applied. */
export function exceedsAllowance(used: number, limit: number, count = 1): boolean {
  return Number.isFinite(limit) && used + count > limit;
}

/** Where a creator stands against the eligibility floor. */
export type PricingEligibility = {
  score: number;
  required: number;
  eligible: boolean;
  /** Score still to earn. 0 once eligible. */
  shortfall: number;
};

/** Fails closed on a missing or malformed score: this decides who may start charging. */
export function pricingEligibility(score: number | null | undefined): PricingEligibility {
  const value = typeof score === 'number' && Number.isFinite(score) ? Math.max(0, score) : 0;
  return {
    score: value,
    required: MONETIZATION_MIN_CREATOR_SCORE,
    eligible: value >= MONETIZATION_MIN_CREATOR_SCORE,
    shortfall: Math.max(0, MONETIZATION_MIN_CREATOR_SCORE - value),
  };
}

/**
 * Refusal text for a creator below the floor. Pass the score wherever it is known: without it the
 * reader is told a threshold and left to guess how far off they are.
 */
export function pricingFloorMessage(score?: number | null): string {
  const standing =
    score == null ? '' : ` Yours is ${pricingEligibility(score).score.toLocaleString()}.`;
  return `You need a creator score of ${MONETIZATION_MIN_CREATOR_SCORE.toLocaleString()} to monetize a model version.${standing} Prices you have already set are unaffected.`;
}

/** Shared wherever a slot is counted or refused: "monetized" alone read as covering Early Access (CU 868m1baec). */
export const PRICING_SLOT_EXPLAINER =
  'This counts versions carrying a licensing fee or permanent paid access. A timed Early Access window is not counted here — it has its own separate limit. Changing a price you have already set is always free.';

export const EARLY_ACCESS_NOT_COUNTED =
  "A timed Early Access window doesn't use a monthly pricing slot — it has its own separate limit.";

export function capTierLabel(tier: string | null | undefined): string | undefined {
  return tier ? CAP_TIER_LABELS[tier as CapTier] : undefined;
}

export function pricingAllowanceMessage(used: number, limit: number, tierLabel?: string): string {
  const tier = tierLabel ? ` on ${tierLabel}` : '';
  return `You have priced ${used} of ${limit} model versions this month${tier}. ${PRICING_SLOT_EXPLAINER} Upgrade your membership to price more, or wait until next month.`;
}

/** What the creator's allowance looks like right now, for every counter and gate in either UI. */
export type PricingAllowanceState = {
  used: number;
  /** `null` = unlimited. */
  limit: number | null;
  unlimited: boolean;
  /** `Infinity` when unlimited, so arithmetic on it stays honest. */
  remaining: number;
  atLimit: boolean;
};

export function pricingAllowanceState({
  used,
  limit,
  exempt = false,
}: {
  used: number;
  limit: number | null;
  /**
   * The caller's already-priced answer for the thing being edited. Without it a header strip reads
   * "used up" while the edit beside it is free.
   */
  exempt?: boolean;
}): PricingAllowanceState {
  const unlimited = limit === null;
  const remaining = unlimited ? Infinity : Math.max(0, limit - used);
  return {
    used,
    limit,
    unlimited,
    remaining,
    atLimit: !exempt && !unlimited && limit > 0 && used >= limit,
  };
}

/** One vocabulary for the counter, shared by the server's refusal and every UI that renders it. */
export function formatPricingAllowance(state: PricingAllowanceState): string {
  if (state.unlimited) return `${state.used} versions priced this month · unlimited`;
  return `${state.used} of ${state.limit} versions priced this month${
    state.atLimit ? ' · limit reached' : ''
  }`;
}

/** How close to the allowance a creator has to be before the upgrade nudge is worth showing. */
export const CAP_UPSELL_THRESHOLD = 0.8;

/** Shared with Creator Studio so both surfaces nudge at the same moment. */
export function shouldUpsellAllowance({
  used,
  limit,
  tier,
}: {
  used: number | null | undefined;
  limit: number;
  tier: CapTier;
}): boolean {
  if (!nextCapTier(tier)) return false;
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return (used ?? 0) >= limit * CAP_UPSELL_THRESHOLD;
}

export type TierAllowanceRow = {
  tier: CapTier;
  label: string;
  /** New prices per calendar month. `null` = unlimited (Infinity doesn't survive serialization). */
  monthlyPrices: number | null;
};

/** Every tier's monthly allowance, for display. */
export function tierAllowanceRows(): TierAllowanceRow[] {
  return CAP_TIERS.map((tier) => ({
    tier,
    label: CAP_TIER_LABELS[tier],
    monthlyPrices: finiteOrNull(monthlyPricingAllowance(tier)),
  }));
}

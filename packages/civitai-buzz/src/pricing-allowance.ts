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
 * Extra licensing-fee slots granted to Creator Program bankers ahead of the November 2026 banking
 * change. Granted per creator; the grant list lives in system Redis and is read by both apps.
 */
export const FEE_ALLOWANCE_BOOST_MAX = 100;
export const FEE_ALLOWANCE_BOOST_ENDS_AT = new Date('2026-11-01T00:00:00Z');

/** The boost's last day as creators read it, e.g. "October 31 (UTC)". */
const BOOST_LAST_DAY = `${new Date(FEE_ALLOWANCE_BOOST_ENDS_AT.getTime() - 1).toLocaleDateString(
  'en-US',
  { month: 'long', day: 'numeric', timeZone: 'UTC' }
)} (UTC)`;

/**
 * The boost a creator holds at `now`: their stored grant clamped to the maximum, or 0 once the window
 * closes. This date check is the cutoff; the key's Redis expiry is only cleanup.
 */
export function feeAllowanceBoost(granted: unknown, now: Date = new Date()): number {
  if (now >= FEE_ALLOWANCE_BOOST_ENDS_AT) return 0;
  const value = typeof granted === 'string' ? Number(granted) : granted;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(FEE_ALLOWANCE_BOOST_MAX, Math.max(0, Math.floor(value)));
}

/**
 * The limit a NEW price is checked against. The boost widens only a licensing fee; a write adding a
 * permanent paid-access gate stays on the tier allowance.
 */
export function pricingLimitFor({
  tier,
  boost,
  addsGate,
}: {
  tier: string | null | undefined;
  boost: number;
  addsGate: boolean;
}): number {
  const base = monthlyPricingAllowance(tier);
  return addsGate ? base : base + boost;
}

/** Both limits a counter needs. `null` = unlimited. A paid-access gate is held to `baseLimit`. */
export function pricingAllowanceLimits({
  tier,
  boost,
}: {
  tier: string | null | undefined;
  boost: number;
}): { baseLimit: number | null; feeLimit: number | null } {
  return {
    baseLimit: finiteOrNull(monthlyPricingAllowance(tier)),
    feeLimit: finiteOrNull(pricingLimitFor({ tier, boost, addsGate: false })),
  };
}

export function feeAllowanceBoostNote(boost: number): string {
  return boost > 0 ? `includes ${boost} extra for licensing fees through ${BOOST_LAST_DAY}` : '';
}

/**
 * Whether putting a permanent gate on versions that already carry a fee would get past the tier
 * allowance. Such a write spends no new slot, so without this a fee-only slot opened by the boost
 * could be turned into a gate the tier never allowed. Only a slot spent this month can have been
 * opened by the boost, and spending at most the tier allowance means every one of them fits in it.
 *
 * `boost` is the raw read: `null` (the grant list could not be read) counts as a grant, because
 * wrongly refusing costs a retry and wrongly allowing costs a gate the tier never allowed.
 */
export function gateConversionExceedsAllowance({
  used,
  tier,
  boost,
  slotSpentThisMonth,
}: {
  used: number;
  tier: string | null | undefined;
  boost: number | null;
  slotSpentThisMonth: boolean;
}): boolean {
  const base = monthlyPricingAllowance(tier);
  return slotSpentThisMonth && boost !== 0 && Number.isFinite(base) && used > base;
}

export function gateConversionMessage(used: number, tier: string | null | undefined): string {
  return `Permanent paid access can't be added this month to a version you licensed this month: you have priced ${used} model versions this month, more than the ${monthlyPricingAllowance(
    tier
  )} your membership allows, and extra licensing-fee slots cover licensing fees only.`;
}

/**
 * Whether an entity already carries a price, exempting it from both rules unless a boosted fee is
 * gaining a gate. A timed early-access window is not a price.
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

/**
 * The refusal for a write checked against `pricingLimitFor`. A boosted creator refused a paid-access
 * gate may still have fee room, so say the extra slots are fee-only.
 */
export function pricingLimitMessage({
  used,
  limit,
  boost,
  addsGate,
  tierLabel,
}: {
  used: number;
  limit: number;
  boost: number;
  addsGate: boolean;
  tierLabel?: string;
}): string {
  const base = pricingAllowanceMessage(used, limit, tierLabel);
  if (boost <= 0) return base;
  return addsGate
    ? `${base} Your ${boost} extra slots through ${BOOST_LAST_DAY} cover licensing fees only, not paid access.`
    : `${base} This includes your ${boost} extra licensing-fee slots through ${BOOST_LAST_DAY}.`;
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

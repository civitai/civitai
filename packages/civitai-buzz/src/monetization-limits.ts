import {
  FEE_IMAGE_OPTIONS,
  finiteOrNull,
  maxLicensingFeeCeiling,
  suggestedFeePerImage,
  type CapMediaType,
} from './licensing-fee';
import { capMediaType } from './media-type';
import { CAP_TIERS, type CapTier } from './paid-access';
import { monthlyPricingAllowance } from './pricing-allowance';

/**
 * What each app knows about a creator's membership. Produced app-side — the main app from the session
 * (`tier` + `memberInBadState`), the spoke from the session plus its moderator test-cookie override.
 * Only the RULE below is shared, not the fetching.
 */
export type Membership = { tier: string | null; isMember: boolean };

/**
 * The tier the monthly allowance resolves against. A lapsed or absent membership falls back to free
 * rather than to "no access", founder counts as bronze, and it returns a real tier — never null — so
 * callers stop carrying a `?? 'free'` fallback that had to be repeated at every site.
 *
 * This is the ONLY tier-normalising rule; everything else that needs a canonical tier goes through it.
 */
export function resolveCapTier(membership: Membership): CapTier {
  if (!membership.isMember) return 'free';
  if (membership.tier === 'founder') return 'bronze';
  return CAP_TIERS.includes(membership.tier as CapTier) ? (membership.tier as CapTier) : 'free';
}

/**
 * The seeded fee for a NEW version, per generation. Deliberately NOT part of MonetizationLimits: it varies
 * by model type and media, never by tier, so folding it in would force callers to invent a tier they don't
 * have. Takes `baseModel` rather than a media type so no caller can name the wrong axis.
 */
export function suggestedFee({
  modelType,
  baseModel,
}: {
  modelType?: string | null;
  baseModel?: string | null;
}): number {
  return suggestedFeePerImage(modelType, capMediaType(baseModel));
}

/** Every limit an editor needs for ONE version. Plain data — no methods, nothing derived twice. */
export type MonetizationLimits = {
  fee: {
    /** Per-generation ceiling. The same for every creator; only the media axis moves it. */
    maxPerGeneration: number;
    /** Denominators the editor may offer. */
    denominators: number[];
  };
  /**
   * New prices this tier may apply per calendar month, or `null` for unlimited (Infinity would not
   * survive a JSON boundary). A count, so the video multiplier doesn't apply.
   */
  allowance: { monthlyPrices: number | null };
};

/**
 * Every limit for a version, from the two things that vary them: the creator's tier (the allowance) and
 * the base model, which decides image vs video (the fee ceiling).
 *
 * Takes an already-resolved `tier` rather than a Membership so the same function answers "what would
 * another tier allow?" — that's what the upgrade nudge renders, and it's why the nudge can't quote a
 * number the counter beside it contradicts.
 *
 * Moderators are NOT special here. They are exempt from the fee CEILING (applied on the write path),
 * but not from the eligibility floor or the allowance — so reporting them an unlimited allowance would
 * promise something the server then refuses.
 */
export function monetizationLimits({
  tier,
  baseModel,
}: {
  tier: CapTier;
  baseModel?: string | null;
}): MonetizationLimits {
  const mediaType: CapMediaType = capMediaType(baseModel);
  return {
    fee: {
      maxPerGeneration: maxLicensingFeeCeiling(mediaType),
      denominators: [...FEE_IMAGE_OPTIONS],
    },
    allowance: { monthlyPrices: finiteOrNull(monthlyPricingAllowance(tier)) },
  };
}

/** The fee ceiling in the editor's whole-number domain: "N buzz per `images` generations". */
export function feeMaxFor(limits: MonetizationLimits, images: number): number {
  return Math.floor(limits.fee.maxPerGeneration * images);
}

import {
  feeImageOptionsForCap,
  finiteOrNull,
  maxLicensingFee,
  maxLicensingFeeCeiling,
  suggestedFeePerImage,
  type CapMediaType,
} from './licensing-fee';
import { capMediaType } from './media-type';
import {
  CAP_TIERS,
  maxPaidAccessPrice,
  maxPermanentAccessModels,
  type CapTier,
} from './paid-access';

/**
 * What each app knows about a creator's membership. Produced app-side — the main app from the session
 * (`tier` + `memberInBadState`), the spoke from the session plus its moderator test-cookie override.
 * Only the RULE below is shared, not the fetching.
 */
export type Membership = { tier: string | null; isMember: boolean };

/**
 * The tier every cap resolves against. A lapsed or absent membership falls back to free rather than to
 * "no access", founder charges as bronze, and it returns a real tier — never null — so callers stop
 * carrying a `?? 'free'` fallback that had to be repeated at every site.
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

/** Every ceiling an editor needs for ONE version. Plain data — no methods, nothing derived twice. */
export type MonetizationLimits = {
  fee: {
    /** Per-generation ceiling. May be fractional (0.1 at free/other), which is why editors use ratios. */
    maxPerGeneration: number;
    /** Denominators the editor may offer: those that can express at least 1 buzz under this cap. */
    denominators: number[];
  };
  /**
   * `null` = unlimited (Infinity would not survive a JSON boundary). A TIMED early-access window is
   * always unlimited: that price is temporary and the version becomes free when the window closes, so
   * the tier ceiling only governs gates that never expire.
   */
  access: { maxPrice: number | null };
  /** `null` = unlimited. A count, so the video multiplier doesn't apply. */
  permanent: { limit: number | null };
};

/**
 * Resolve every tier-dependent cap for a version from the three things that vary them: the creator's tier,
 * the model type, and the base model (which decides image vs video).
 *
 * Takes an already-resolved `tier` rather than a Membership so the same function answers "what would
 * another tier allow?" — that's what the upgrade nudge renders, and it's why the nudge can't quote a
 * number the input beside it contradicts.
 *
 * Moderators aren't tier-capped: they get the absolute ceiling and every denominator.
 */
export function monetizationLimits({
  tier,
  modelType,
  baseModel,
  isModerator = false,
  permanent = true,
}: {
  tier: CapTier;
  modelType?: string | null;
  baseModel?: string | null;
  isModerator?: boolean;
  /**
   * Whether the gate being priced never expires. Defaults to true — the capped case — so a caller that
   * forgets it gets the ceiling rather than accidentally uncapping a permanent gate.
   */
  permanent?: boolean;
}): MonetizationLimits {
  const mediaType: CapMediaType = capMediaType(baseModel);
  return {
    fee: {
      maxPerGeneration: isModerator
        ? maxLicensingFeeCeiling(mediaType)
        : maxLicensingFee(tier, modelType, mediaType),
      // Gold's ceiling admits every denominator, which is what an uncapped moderator should see.
      denominators: feeImageOptionsForCap(isModerator ? 'gold' : tier, modelType, mediaType),
    },
    access: {
      maxPrice:
        isModerator || !permanent ? null : finiteOrNull(maxPaidAccessPrice(tier, mediaType)),
    },
    permanent: {
      limit: isModerator ? null : finiteOrNull(maxPermanentAccessModels(tier)),
    },
  };
}

/**
 * The fee ceiling in the editor's whole-number domain: "N buzz per `images` generations".
 *
 * Derived rather than looked up, so it stays exact for a denominator the tier can't express — a creator
 * who set 5 ⚡/generation and then lapsed opens the editor at `images = 1`, which free tier has no valid
 * entry for, and must see the real ceiling (0) rather than a fallback borrowed from another denominator.
 */
export function feeMaxFor(limits: MonetizationLimits, images: number): number {
  return Math.floor(limits.fee.maxPerGeneration * images);
}

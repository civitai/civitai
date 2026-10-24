// Which gate kinds a selection can take, and what to tell the creator about the part it can't reach.

import { pricingFloorMessage, type PricingEligibility } from '@civitai/buzz';

export type GateEligibilityInput = {
  selectedCount: number;
  /** Selected versions that have been published at some point — a timed window can never reach these. */
  publishedCount: number;
  /** 0 when the creator's score hasn't unlocked early access at all. */
  maxEarlyAccessDays: number;
  pricingSlotsLeft: number;
  /**
   * Where the creator stands against the monetization floor. It gates a PERMANENT gate only: a timed
   * window is not a price, spends no slot, and prices itself out when it closes.
   */
  pricingFloor: PricingEligibility;
  /** The selection already carries a price, so neither the floor nor the allowance applies to it. */
  alreadyPriced: boolean;
  /** True while the published count is still being fetched — treated as "can't offer timed yet". */
  resolving: boolean;
};

export type GateEligibility = {
  /** Selected versions a timed window would actually apply to. */
  eligibleForTimed: number;
  canChooseTimed: boolean;
  canChoosePermanent: boolean;
  permBlocked: boolean;
  /**
   * Why a permanent gate is unavailable, when the reason is the floor rather than the allowance. The
   * allowance case is worded by the caller, which has the counter to interpolate.
   */
  permBlockedReason?: string;
  /** Why timed is unavailable at all. Absent when it is available. */
  timedBlockedReason?: string;
  /** Set when timed is available but won't reach the whole selection. */
  timedPartialNotice?: { skipped: number; applies: number };
};

export function resolveGateEligibility({
  selectedCount,
  publishedCount,
  maxEarlyAccessDays,
  pricingSlotsLeft,
  pricingFloor,
  alreadyPriced,
  resolving,
}: GateEligibilityInput): GateEligibility {
  const eligibleForTimed = Math.max(0, selectedCount - publishedCount);
  const scoreAllowsTimed = maxEarlyAccessDays > 0;
  const canChooseTimed = scoreAllowsTimed && !resolving && eligibleForTimed > 0;

  let timedBlockedReason: string | undefined;
  if (!scoreAllowsTimed)
    timedBlockedReason =
      "Early access isn't available for your account yet — it unlocks as your creator score grows.";
  else if (resolving) timedBlockedReason = 'Checking which versions have been published…';
  else if (eligibleForTimed <= 0)
    timedBlockedReason =
      selectedCount === 1
        ? "This version has been published — early access can't be started after publishing."
        : "Every selected version has been published — early access can't be started after publishing.";

  const belowFloor = !alreadyPriced && !pricingFloor.eligible;
  const canChoosePermanent = !belowFloor && pricingSlotsLeft > 0;

  return {
    eligibleForTimed,
    canChooseTimed,
    canChoosePermanent,
    permBlocked: !canChoosePermanent,
    permBlockedReason: belowFloor ? pricingFloorMessage(pricingFloor.score) : undefined,
    timedBlockedReason,
    timedPartialNotice:
      canChooseTimed && publishedCount > 0
        ? { skipped: publishedCount, applies: eligibleForTimed }
        : undefined,
  };
}

// Which gate kinds a selection can take, and what to tell the creator about the part it can't reach.

export type GateEligibilityInput = {
  selectedCount: number;
  /** Selected versions that have been published at some point — a timed window can never reach these. */
  publishedCount: number;
  /** 0 when the creator's score hasn't unlocked early access at all. */
  maxEarlyAccessDays: number;
  pricingSlotsLeft: number;
  /** True while the published count is still being fetched — treated as "can't offer timed yet". */
  resolving: boolean;
};

export type GateEligibility = {
  /** Selected versions a timed window would actually apply to. */
  eligibleForTimed: number;
  canChooseTimed: boolean;
  canChoosePermanent: boolean;
  permBlocked: boolean;
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

  return {
    eligibleForTimed,
    canChooseTimed,
    canChoosePermanent: pricingSlotsLeft > 0,
    permBlocked: pricingSlotsLeft <= 0,
    timedBlockedReason,
    timedPartialNotice:
      canChooseTimed && publishedCount > 0
        ? { skipped: publishedCount, applies: eligibleForTimed }
        : undefined,
  };
}

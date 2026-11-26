// A port of the main app's rewards-multiplier fold (src/server/redis/user-multipliers.ts and
// src/server/rewards/multiplier.ts). The two apps share no runtime code, so
// src/server/redis/__tests__/moderator-user-multipliers.parity.test.ts runs both on the same rows:
// a change to either side without the other goes red. No imports here, so that test can load it.

export type UserMultiplierRow = {
  userId: number;
  rewardsIneligible: boolean;
  rewardsMultiplier: number | null;
  purchasesMultiplier: number | null;
};

const BASE_MULTIPLIER = 1;

// `Number()` first: a value read back through a driver can be a numeric string at runtime.
function clampRewardMultiplier(multiplier: number): number {
  const raw = Number(multiplier);
  if (!Number.isFinite(raw)) return raw < 0 ? 0 : 1;
  return Math.max(raw, 0);
}

const usable = (value: number | null | undefined) =>
  value == null ? BASE_MULTIPLIER : clampRewardMultiplier(value);

/** Best rewards multiplier across a user's active subscriptions; 0 when the user is ineligible. */
export function foldRewardsMultipliers(rows: UserMultiplierRow[]): Map<number, number> {
  const best = new Map<number, number>();
  const ineligible = new Set<number>();
  for (const row of rows) {
    if (row.rewardsIneligible) ineligible.add(row.userId);
    best.set(
      row.userId,
      Math.max(best.get(row.userId) ?? -Infinity, usable(row.rewardsMultiplier))
    );
  }
  for (const userId of ineligible) best.set(userId, 0);
  return best;
}

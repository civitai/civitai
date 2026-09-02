import { clampRewardMultiplier } from '~/server/rewards/multiplier';

export type UserMultipliers = {
  userId: number;
  rewardsMultiplier: number;
  purchasesMultiplier: number;
  rewardsIneligible: boolean;
};

export type UserMultiplierRow = {
  userId: number;
  rewardsIneligible: boolean;
  rewardsMultiplier: number | null;
  purchasesMultiplier: number | null;
};

const BASE_MULTIPLIER = 1;

/**
 * `Math.max` below is a max ACROSS ROWS, not a floor: one row of -1 yields -1, and a
 * `Product.metadata` value is operator-authored, so NaN and Infinity arrive the same way.
 */
const usable = (value: number | null | undefined) =>
  value == null ? BASE_MULTIPLIER : clampRewardMultiplier(value);

/**
 * Takes the best multiplier across every active subscription a user holds rather than the one
 * highest-ranked row. A referral grant (civitai-referral-*) and a buzz-purchase grant
 * (civitai-buzz-*) are placeholders that convey a tier and no perks, and either can out-rank a
 * paid membership at the same tier on the date tiebreak — silently zeroing the multiplier the
 * member is paying for. See ClickUp 868kv4q7t / 868kr8bh3.
 *
 * A row with no multiplier counts as 1, but the result is NOT floored at 1 — a product priced
 * below 1 keeps its value, as it did when this was one COALESCE over a single winning row. It IS
 * floored at 0, which preserves that: every sub-1 product is still above the floor.
 *
 * `rewardsIneligible` is taken from the first row seen for a user, which is safe only because the
 * query computes it off `User`, so every row for a user carries the same value. Move that
 * expression to a joined table and this needs to fold rather than take the first.
 */
export function foldUserMultipliers(rows: UserMultiplierRow[]): Record<number, UserMultipliers> {
  const records: Record<number, UserMultipliers> = {};

  for (const row of rows) {
    const existing = records[row.userId];
    if (!existing) {
      records[row.userId] = {
        userId: row.userId,
        rewardsIneligible: row.rewardsIneligible,
        rewardsMultiplier: usable(row.rewardsMultiplier),
        purchasesMultiplier: usable(row.purchasesMultiplier),
      };
      continue;
    }

    existing.rewardsMultiplier = Math.max(
      existing.rewardsMultiplier,
      usable(row.rewardsMultiplier)
    );
    existing.purchasesMultiplier = Math.max(
      existing.purchasesMultiplier,
      usable(row.purchasesMultiplier)
    );
  }

  for (const record of Object.values(records)) {
    if (record.rewardsIneligible) record.rewardsMultiplier = 0;
  }

  return records;
}

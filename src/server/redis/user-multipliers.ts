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
 * Takes the best multiplier across every active subscription a user holds rather than the one
 * highest-ranked row. A referral grant (civitai-referral-*) and a buzz-purchase grant
 * (civitai-buzz-*) are placeholders that convey a tier and no perks, and either can out-rank a
 * paid membership at the same tier on the date tiebreak — silently zeroing the multiplier the
 * member is paying for. See ClickUp 868kv4q7t / 868kr8bh3.
 *
 * A row with no multiplier counts as 1, but the result is NOT floored at 1 — a product priced
 * below 1 keeps its value, as it did when this was one COALESCE over a single winning row.
 */
export function foldUserMultipliers(rows: UserMultiplierRow[]): Record<number, UserMultipliers> {
  const records: Record<number, UserMultipliers> = {};

  for (const row of rows) {
    const existing = records[row.userId];
    if (!existing) {
      records[row.userId] = {
        userId: row.userId,
        rewardsIneligible: row.rewardsIneligible,
        rewardsMultiplier: row.rewardsMultiplier ?? BASE_MULTIPLIER,
        purchasesMultiplier: row.purchasesMultiplier ?? BASE_MULTIPLIER,
      };
      continue;
    }

    existing.rewardsMultiplier = Math.max(
      existing.rewardsMultiplier,
      row.rewardsMultiplier ?? BASE_MULTIPLIER
    );
    existing.purchasesMultiplier = Math.max(
      existing.purchasesMultiplier,
      row.purchasesMultiplier ?? BASE_MULTIPLIER
    );
  }

  for (const record of Object.values(records)) {
    if (record.rewardsIneligible) record.rewardsMultiplier = 0;
  }

  return records;
}

import { dbRead, dbWrite } from '~/server/db/client';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { milestoneGrantableUserSql } from '~/server/services/creator-milestone-exclusions';

export const MILESTONE_RARITY_KEY = 'creator-journey:milestone-rarity';

/**
 * "Creators" are accounts that could hold a milestone and have a Creator Score above zero. Holders
 * are counted within that same set, so a share never passes 100%.
 */
export const milestoneRarityCountSql = `
  WITH creators AS MATERIALIZED (
    SELECT u.id FROM "User" u
    WHERE ${milestoneGrantableUserSql('u')}
      AND (u.meta->'scores'->>'total')::numeric > 0
  )
  SELECT m.key, count(c.id)::int AS holders, (SELECT count(*) FROM creators)::int AS creators
  FROM "CreatorMilestone" m
  LEFT JOIN "UserCreatorMilestone" h ON h."milestoneKey" = m.key
  LEFT JOIN creators c ON c.id = h."userId"
  WHERE NOT m.hidden
  GROUP BY m.key
`;

export type MilestoneRarity = { at: number; creators: number; holders: Record<string, number> };

export async function computeMilestoneRarity(pg: AugmentedPool): Promise<MilestoneRarity> {
  const query = await pg.cancellableQuery<{ key: string; holders: number; creators: number }>(
    milestoneRarityCountSql
  );
  const rows = await query.result();
  return {
    at: Date.now(),
    creators: rows[0]?.creators ?? 0,
    holders: Object.fromEntries(rows.map((row) => [row.key, row.holders])),
  };
}

export async function storeMilestoneRarity(rarity: MilestoneRarity) {
  await dbWrite.keyValue.upsert({
    where: { key: MILESTONE_RARITY_KEY },
    create: { key: MILESTONE_RARITY_KEY, value: rarity },
    update: { value: rarity },
  });
}

/** A count this old means the job has stopped; showing nothing beats showing last month's share. */
const MAX_RARITY_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** The last nightly count; null before the first run, when it is stale, or when the row is malformed. */
export async function getMilestoneRarity(): Promise<MilestoneRarity | null> {
  const row = await dbRead.keyValue.findUnique({ where: { key: MILESTONE_RARITY_KEY } });
  const value = row?.value as Partial<MilestoneRarity> | null | undefined;
  if (
    typeof value?.at !== 'number' ||
    Date.now() - value.at > MAX_RARITY_AGE_MS ||
    typeof value.creators !== 'number' ||
    !value.holders ||
    typeof value.holders !== 'object'
  )
    return null;
  return value as MilestoneRarity;
}

/**
 * The share of creators holding `milestone`, in percent, or null when it is hidden or uncounted.
 * Checked against the current definition, not just the stored count.
 */
export function milestoneRarityPercent(
  rarity: MilestoneRarity | null,
  milestone: { key: string; hidden: boolean }
): number | null {
  if (milestone.hidden || !rarity || rarity.creators <= 0) return null;
  const holders = rarity.holders[milestone.key];
  if (typeof holders !== 'number') return null;
  return Math.min((holders / rarity.creators) * 100, 100);
}

import type { AugmentedPool } from '~/server/db/db-helpers';
import type { CREATOR_SCORE_CATEGORIES } from '~/shared/utils/creator-score';

export type SelfImageEngagement = { reactions: number; comments: number };

/**
 * `meta.scores` key stamped on an owner once their own past reactions and comments are out of their
 * `images` score, so a re-run cannot subtract them twice.
 */
export const IMAGE_SELF_EXCLUDED_STAMP = 'imageSelfExcludedAt';

/**
 * Reactions and top-level comments each owner left on their own images before `before`: the
 * engagement the nightly `images` score no longer credits.
 */
export async function countSelfImageEngagement(
  pg: AugmentedPool,
  ownerIds: number[],
  before: Date
): Promise<Map<number, SelfImageEngagement>> {
  const result = new Map<number, SelfImageEngagement>();
  if (!ownerIds.length) return result;
  const entry = (userId: number) => {
    const existing = result.get(userId) ?? { reactions: 0, comments: 0 };
    result.set(userId, existing);
    return existing;
  };

  // Walks each owner's images; ImageReaction (imageId, userId) answers each with one index probe.
  const reactions = await pg.cancellableQuery<{ userId: number; count: number }>(
    `SELECT i."userId", count(*)::int AS count
     FROM "Image" i
     JOIN "ImageReaction" r ON r."imageId" = i.id AND r."userId" = i."userId"
     WHERE i."userId" = ANY($1::int[])
       AND r.reaction IN ('Like', 'Heart', 'Laugh', 'Cry')
       AND r."createdAt" < $2
     GROUP BY 1`,
    [ownerIds, before]
  );
  for (const { userId, count } of await reactions.result()) entry(userId).reactions = count;

  const comments = await pg.cancellableQuery<{ userId: number; count: number }>(
    `SELECT i."userId", count(*)::int AS count
     FROM "CommentV2" c
     JOIN "Thread" t ON t.id = c."threadId"
     JOIN "Image" i ON i.id = t."imageId" AND i."userId" = c."userId"
     WHERE c."userId" = ANY($1::int[])
       AND c."createdAt" < $2
     GROUP BY 1`,
    [ownerIds, before]
  );
  for (const { userId, count } of await comments.result()) entry(userId).comments = count;

  return result;
}

/** Owners with an `images` score whose own engagement has not been taken out of it yet. */
export async function listImageOwnersToExclude(pg: AugmentedPool) {
  const rows = await pg
    .cancellableQuery<{ id: number }>(
      `SELECT id FROM "User"
       WHERE (meta->'scores'->>'images')::numeric > 0
         AND (meta->'scores'->>'${IMAGE_SELF_EXCLUDED_STAMP}') IS NULL`
    )
    .then((q) => q.result());
  return rows.map((r) => r.id);
}

/** Floors at zero. */
export function imagesScoreWithoutSelf(
  stored: number,
  self: SelfImageEngagement | undefined,
  multipliers: { reactions: number; comments: number }
) {
  if (!self) return stored;
  return Math.max(
    0,
    stored - self.reactions * multipliers.reactions - self.comments * multipliers.comments
  );
}

export type StoredScores = Partial<
  Record<(typeof CREATOR_SCORE_CATEGORIES)[number] | 'total', number>
>;
export type ScoreTier = { key: string; threshold: number };
export type TierReport = { up: number; down: number; belowTier: number };

/** The highest tier `total` reaches, or `none`. `tiers` is sorted by threshold, ascending. */
export function tierOf(total: number, tiers: ScoreTier[]) {
  let key = 'none';
  for (const tier of tiers) if (total >= tier.threshold) key = tier.key;
  return key;
}

/**
 * How many owners in each tier (by their stored total) move up, down, or below that tier's
 * threshold once `changes` replace their stored categories. Owners whose categories do not move are
 * left out of `changed`.
 */
export function summariseScoreChanges(
  changes: Map<number, { models?: number; images?: number }>,
  storedByUser: Map<number, StoredScores>,
  tiers: ScoreTier[]
) {
  const byTier: Record<string, TierReport> = {};
  const changed: [string, { models?: number; images?: number }][] = [];
  for (const [userId, change] of changes) {
    const stored = storedByUser.get(userId) ?? {};
    const oldTotal = stored.total ?? 0;
    const delta = (['models', 'images'] as const).reduce(
      (sum, category) =>
        change[category] === undefined ? sum : sum + change[category]! - (stored[category] ?? 0),
      0
    );
    if (delta === 0) continue;
    const newTotal = oldTotal + delta;
    changed.push([String(userId), change]);
    const tier = tierOf(oldTotal, tiers);
    const report = (byTier[tier] ??= { up: 0, down: 0, belowTier: 0 });
    if (newTotal > oldTotal) report.up++;
    else report.down++;
    if (tierOf(newTotal, tiers) !== tier && newTotal < oldTotal) report.belowTier++;
  }
  return { changed, byTier };
}

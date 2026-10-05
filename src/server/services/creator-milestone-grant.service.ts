import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import type { AugmentedPool } from '~/server/db/db-helpers';
import type { CreatorScoreUnlock } from '~/server/services/creator-score-unlocks.service';
import { nextCreatorScoreUnlocks } from '~/server/services/creator-score-unlocks.service';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const SYSTEM_USER_ID = constants.system.user.id;

export type ScoreTotalTransition = { userId: number; oldTotal: number | null; newTotal: number };

export type ScoreTierCrossing = {
  userId: number;
  milestoneKey: string;
  name: string;
  threshold: number;
};

type CancelHook = (cancel: () => Promise<void>) => void;

/**
 * Grants every score-track milestone at or below each user's new total. A row whose threshold the OLD
 * total had already reached is stamped seen, because it is a late grant rather than a crossing, and
 * only crossings come back to be announced. The milestone's cosmetic, if it has one, is granted with
 * the milestone key as its claimKey.
 */
export async function grantScoreTierMilestones(
  pg: AugmentedPool,
  transitions: ScoreTotalTransition[],
  onCancel?: CancelHook
): Promise<ScoreTierCrossing[]> {
  const rows = transitions.filter((t) => t.userId !== SYSTEM_USER_ID);
  if (!rows.length) return [];

  const query = await pg.cancellableQuery<ScoreTierCrossing>(
    `
    WITH t AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb)
        AS x("userId" int, "oldTotal" numeric, "newTotal" numeric)
    ), granted AS (
      INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "seenAt")
      SELECT t."userId", m.key,
        CASE WHEN COALESCE(t."oldTotal", 0) < m.threshold THEN NULL ELSE now() END
      FROM t
      JOIN "CreatorMilestone" m
        ON m.track = 'score' AND m.threshold IS NOT NULL AND t."newTotal" >= m.threshold
      WHERE t."userId" <> ${SYSTEM_USER_ID}
      ON CONFLICT DO NOTHING
      RETURNING "userId", "milestoneKey", "seenAt"
    ), cosmetics AS (
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT g."userId", m."cosmeticId", m.key
      FROM granted g
      JOIN "CreatorMilestone" m ON m.key = g."milestoneKey"
      WHERE m."cosmeticId" IS NOT NULL
      ON CONFLICT DO NOTHING
    )
    SELECT g."userId", g."milestoneKey", m.name, m.threshold
    FROM granted g
    JOIN "CreatorMilestone" m ON m.key = g."milestoneKey"
    WHERE g."seenAt" IS NULL
    `,
    [JSON.stringify(rows)]
  );
  onCancel?.(query.cancel);
  return query.result();
}

export type MilestoneBatchResult = { users: number; inserted: number; lastUserId: number | null };

/**
 * One batch of the launch backfill: the next `limit` users above `afterUserId` whose total reaches the
 * lowest score tier, granted every tier they hold in the same statement. Rows are stamped seen so the
 * journey page has nothing to reveal, and nothing is announced.
 */
export async function backfillScoreTierBatch(
  pg: AugmentedPool,
  { afterUserId, maxUserId, limit }: { afterUserId: number; maxUserId?: number; limit: number }
): Promise<MilestoneBatchResult> {
  const query = await pg.cancellableQuery<MilestoneBatchResult>(
    `
    WITH u AS (
      SELECT id, (meta->'scores'->>'total')::numeric AS total
      FROM "User"
      WHERE id > $1
        AND ($2::int IS NULL OR id <= $2)
        AND id <> ${SYSTEM_USER_ID}
        AND (meta->'scores'->>'total')::numeric >= (
          SELECT min(threshold) FROM "CreatorMilestone" WHERE track = 'score'
        )
      ORDER BY id
      LIMIT $3
    ), granted AS (
      INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "seenAt")
      SELECT u.id, m.key, now()
      FROM u
      JOIN "CreatorMilestone" m
        ON m.track = 'score' AND m.threshold IS NOT NULL AND u.total >= m.threshold
      ON CONFLICT DO NOTHING
      RETURNING "userId", "milestoneKey"
    ), cosmetics AS (
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT g."userId", m."cosmeticId", m.key
      FROM granted g
      JOIN "CreatorMilestone" m ON m.key = g."milestoneKey"
      WHERE m."cosmeticId" IS NOT NULL
      ON CONFLICT DO NOTHING
    )
    SELECT
      (SELECT count(*) FROM u)::int AS users,
      (SELECT count(*) FROM granted)::int AS inserted,
      (SELECT max(id) FROM u) AS "lastUserId"
    `,
    [afterUserId, maxUserId ?? null, limit]
  );
  const [row] = await query.result();
  return row;
}

/**
 * Grants the cosmetic of every milestone that has one to that milestone's existing holders, for the
 * next `limit` holders above `afterUserId`. This is what runs after art is attached to a definition
 * that already has holders, since live grants only cover rows created from then on.
 */
export async function grantMilestoneCosmeticsBatch(
  pg: AugmentedPool,
  {
    afterUserId,
    maxUserId,
    limit,
    milestoneKey,
  }: { afterUserId: number; maxUserId?: number; limit: number; milestoneKey?: string }
): Promise<MilestoneBatchResult> {
  const query = await pg.cancellableQuery<MilestoneBatchResult>(
    `
    WITH m AS (
      SELECT key, "cosmeticId"
      FROM "CreatorMilestone"
      WHERE "cosmeticId" IS NOT NULL AND ($4::text IS NULL OR key = $4)
    ), u AS (
      SELECT DISTINCT ucm."userId" AS id
      FROM "UserCreatorMilestone" ucm
      WHERE ucm."userId" > $1
        AND ($2::int IS NULL OR ucm."userId" <= $2)
        AND ucm."milestoneKey" IN (SELECT key FROM m)
      ORDER BY 1
      LIMIT $3
    ), granted AS (
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT ucm."userId", m."cosmeticId", m.key
      FROM u
      JOIN "UserCreatorMilestone" ucm ON ucm."userId" = u.id
      JOIN m ON m.key = ucm."milestoneKey"
      ON CONFLICT DO NOTHING
      RETURNING "userId"
    )
    SELECT
      (SELECT count(*) FROM u)::int AS users,
      (SELECT count(*) FROM granted)::int AS inserted,
      (SELECT max(id) FROM u) AS "lastUserId"
    `,
    [afterUserId, maxUserId ?? null, limit, milestoneKey ?? null]
  );
  const [row] = await query.result();
  return row;
}

const MAX_UNLOCKS_NAMED = 3;

/** The unlocks that sit exactly on a tier's threshold, which is what reaching the tier granted. */
export function unlocksAtTier(unlocks: CreatorScoreUnlock[], threshold: number): string[] {
  const labels = nextCreatorScoreUnlocks(unlocks, { total: threshold - 1 })
    .filter((unlock) => unlock.minScore === threshold)
    .map((unlock) => unlock.label);
  return [...new Set(labels)];
}

export function getScoreTierNotificationDetails(
  crossing: ScoreTierCrossing,
  unlocks: CreatorScoreUnlock[]
) {
  const labels = unlocksAtTier(unlocks, crossing.threshold);
  return {
    milestoneKey: crossing.milestoneKey,
    tierName: crossing.name,
    threshold: crossing.threshold,
    unlocks: labels.slice(0, MAX_UNLOCKS_NAMED),
    moreUnlocks: Math.max(0, labels.length - MAX_UNLOCKS_NAMED),
  };
}

export async function notifyScoreTierCrossings(
  crossings: ScoreTierCrossing[],
  unlocks: CreatorScoreUnlock[]
) {
  await limitConcurrency(
    crossings.map(
      (crossing) => () =>
        createNotification({
          type: 'creator-score-tier-reached',
          category: NotificationCategory.Milestone,
          key: `creator-score-tier-reached:${crossing.userId}:${crossing.milestoneKey}`,
          userId: crossing.userId,
          details: getScoreTierNotificationDetails(crossing, unlocks),
        })
    ),
    4
  );
}

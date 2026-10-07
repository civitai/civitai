import { NotificationCategory } from '~/server/common/enums';
import type { AugmentedPool } from '~/server/db/db-helpers';
import type { CreatorScoreUnlock } from '~/shared/utils/creator-score-unlocks';
import { nextCreatorScoreUnlocks } from '~/shared/utils/creator-score-unlocks';
import {
  joinMilestoneGrantableUserSql,
  milestoneGrantableUserSql,
  owedScoreTierSql,
} from '~/server/services/creator-milestone-exclusions';
import { createNotification } from '~/server/services/notification.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export type ScoreTotalTransition = { userId: number; oldTotal: number | null; newTotal: number };

export type ScoreTierCrossing = {
  userId: number;
  milestoneKey: string;
  name: string;
  threshold: number;
};

type CancelHook = (cancel: () => Promise<void>) => void;

/**
 * SQL selecting one grant candidate per row: "userId" int, "milestoneKey" text, "achievedAt" timestamp
 * (NULL for now) and "silent" boolean. A silent grant is stamped seen, so it is never announced; a
 * NULL "silent" counts as silent.
 */
export type MilestoneCandidates = { sql: string; params: unknown[] };

export type MilestoneGrant = {
  userId: number;
  milestoneKey: string;
  name: string;
  threshold: number | null;
  silent: boolean;
};

/**
 * Inserts the rows of CTE `candidates`, returning only the new ones. Every grant path goes through it,
 * so none can skip the account exclusions.
 */
export function insertMilestoneGrantsSql(candidates: string) {
  return `INSERT INTO "UserCreatorMilestone" ("userId", "milestoneKey", "achievedAt", "seenAt")
      SELECT c."userId", c."milestoneKey", COALESCE(c."achievedAt", CURRENT_TIMESTAMP),
        CASE WHEN COALESCE(c.silent, true) THEN now() END
      FROM ${candidates} c
      ${joinMilestoneGrantableUserSql('u', 'c."userId"')}
      ON CONFLICT DO NOTHING
      RETURNING "userId", "milestoneKey", "seenAt" IS NOT NULL AS silent`;
}

/**
 * Whether a row's `achievedAt` is when the milestone happened, rather than when a silent grant caught
 * up with it (a launch backfill, or a tier the user had already passed). A silent grant with no
 * achievedAt of its own stamps both columns in one INSERT, so they are equal; every other row is
 * unseen at insert and stamped later, or carries the detector's own achievedAt.
 */
export function achievedAtIsObserved(row: { achievedAt: Date; seenAt: Date | null }) {
  return row.seenAt?.getTime() !== row.achievedAt.getTime();
}

/** achievedAtIsObserved as a predicate on a "UserCreatorMilestone" alias, for filtering in SQL. */
export function achievedAtIsObservedSql(alias: string) {
  return `${alias}."seenAt" IS DISTINCT FROM ${alias}."achievedAt"`;
}

/** One row per cosmetic a milestone grants: its badge, then any extras. */
const milestoneCosmeticsSql = `
  SELECT key AS "milestoneKey", "cosmeticId" FROM "CreatorMilestone" WHERE "cosmeticId" IS NOT NULL
  UNION
  SELECT "milestoneKey", "cosmeticId" FROM "CreatorMilestoneCosmetic"`;

/** Grants each row of CTE `granted` its milestone's cosmetics, claimed under the milestone key. */
export function insertMilestoneCosmeticsSql(granted: string) {
  return `INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT g."userId", mc."cosmeticId", mc."milestoneKey"
      FROM ${granted} g
      JOIN (${milestoneCosmeticsSql}) mc ON mc."milestoneKey" = g."milestoneKey"
      ON CONFLICT DO NOTHING`;
}

export async function grantMilestones(
  pg: AugmentedPool,
  candidates: MilestoneCandidates,
  onCancel?: CancelHook
): Promise<MilestoneGrant[]> {
  const query = await pg.cancellableQuery<MilestoneGrant>(
    `
    WITH candidates AS (${candidates.sql}),
    granted AS (${insertMilestoneGrantsSql('candidates')}),
    cosmetics AS (${insertMilestoneCosmeticsSql('granted')})
    SELECT g."userId", g."milestoneKey", m.name, m.threshold, g.silent
    FROM granted g
    JOIN "CreatorMilestone" m ON m.key = g."milestoneKey"
    `,
    candidates.params
  );
  onCancel?.(query.cancel);
  return query.result();
}

/**
 * Grants every score-track milestone at or below each user's new total. A tier the OLD total had
 * already reached is a late grant rather than a crossing, so it is granted silently, and only
 * crossings come back to be announced.
 */
export async function grantScoreTierMilestones(
  pg: AugmentedPool,
  transitions: ScoreTotalTransition[],
  onCancel?: CancelHook
): Promise<ScoreTierCrossing[]> {
  if (!transitions.length) return [];

  const grants = await grantMilestones(
    pg,
    {
      sql: `
        SELECT t."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt",
          COALESCE(t."oldTotal", 0) >= m.threshold AS silent
        FROM jsonb_to_recordset($1::jsonb)
          AS t("userId" int, "oldTotal" numeric, "newTotal" numeric)
        JOIN "CreatorMilestone" m
          ON m.track = 'score' AND m.threshold IS NOT NULL AND t."newTotal" >= m.threshold`,
      params: [JSON.stringify(transitions)],
    },
    onCancel
  );
  return grants
    .filter((grant) => !grant.silent)
    .map(({ userId, milestoneKey, name, threshold }) => ({
      userId,
      milestoneKey,
      name,
      threshold: threshold as number,
    }));
}

/**
 * Stamps crossings seen without announcing them. Only unseen rows are touched, so a re-run changes
 * nothing.
 */
export async function markMilestonesSeen(
  pg: AugmentedPool,
  crossings: Pick<ScoreTierCrossing, 'userId' | 'milestoneKey'>[],
  onCancel?: CancelHook
) {
  if (!crossings.length) return;
  const query = await pg.cancellableQuery(
    `
    UPDATE "UserCreatorMilestone" ucm
    SET "seenAt" = now()
    FROM jsonb_to_recordset($1::jsonb) AS x("userId" int, "milestoneKey" text)
    WHERE ucm."userId" = x."userId" AND ucm."milestoneKey" = x."milestoneKey"
      AND ucm."seenAt" IS NULL
    `,
    [JSON.stringify(crossings.map(({ userId, milestoneKey }) => ({ userId, milestoneKey })))]
  );
  onCancel?.(query.cancel);
  await query.result();
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
    WITH batch AS (
      SELECT u.id, (u.meta->'scores'->>'total')::numeric AS total
      FROM "User" u
      WHERE u.id > $1
        AND ($2::int IS NULL OR u.id <= $2)
        AND ${milestoneGrantableUserSql('u')}
        AND (u.meta->'scores'->>'total')::numeric >= (
          SELECT min(threshold) FROM "CreatorMilestone" WHERE track = 'score'
        )
      ORDER BY u.id
      LIMIT $3
    ), candidates AS (
      SELECT batch.id AS "userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt",
        true AS silent
      FROM batch
      JOIN "CreatorMilestone" m
        ON m.track = 'score' AND m.threshold IS NOT NULL AND batch.total >= m.threshold
    ),
    granted AS (${insertMilestoneGrantsSql('candidates')}),
    cosmetics AS (${insertMilestoneCosmeticsSql('granted')})
    SELECT
      (SELECT count(*) FROM batch)::int AS users,
      (SELECT count(*) FROM granted)::int AS inserted,
      (SELECT max(id) FROM batch) AS "lastUserId"
    `,
    [afterUserId, maxUserId ?? null, limit]
  );
  const [row] = await query.result();
  return row;
}

/**
 * Grants the cosmetics of every milestone that has any to that milestone's existing holders, for the
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
      SELECT "milestoneKey" AS key, "cosmeticId"
      FROM (${milestoneCosmeticsSql}) mc
      WHERE $4::text IS NULL OR "milestoneKey" = $4
    ), batch AS (
      SELECT DISTINCT ucm."userId" AS id
      FROM "UserCreatorMilestone" ucm
      ${joinMilestoneGrantableUserSql('u', 'ucm."userId"')}
      WHERE ucm."userId" > $1
        AND ($2::int IS NULL OR ucm."userId" <= $2)
        AND ucm."milestoneKey" IN (SELECT key FROM m)
      ORDER BY 1
      LIMIT $3
    ), granted AS (
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey")
      SELECT ucm."userId", m."cosmeticId", m.key
      FROM batch
      JOIN "UserCreatorMilestone" ucm ON ucm."userId" = batch.id
      JOIN m ON m.key = ucm."milestoneKey"
      ON CONFLICT DO NOTHING
      RETURNING "userId"
    )
    SELECT
      (SELECT count(*) FROM batch)::int AS users,
      (SELECT count(*) FROM granted)::int AS inserted,
      (SELECT max(id) FROM batch) AS "lastUserId"
    `,
    [afterUserId, maxUserId ?? null, limit, milestoneKey ?? null]
  );
  const [row] = await query.result();
  return row;
}

type UserRange = { afterUserId: number; maxUserId?: number };
export type BackfillPreview = { users: number; rows: number };

/** What `backfillScoreTierBatch` would insert over the whole range, read only. */
export async function previewScoreTierBackfill(
  pg: AugmentedPool,
  { afterUserId, maxUserId }: UserRange
): Promise<BackfillPreview> {
  const query = await pg.cancellableQuery<BackfillPreview>(
    `
    SELECT count(DISTINCT u.id)::int AS users, count(*)::int AS rows
    FROM "User" u
    JOIN "CreatorMilestone" m ON ${owedScoreTierSql('u', 'm')}
    WHERE u.id > $1 AND ($2::int IS NULL OR u.id <= $2)
      AND ${milestoneGrantableUserSql('u')}
    `,
    [afterUserId, maxUserId ?? null]
  );
  const [row] = await query.result();
  return row;
}

/** What `grantMilestoneCosmeticsBatch` would insert over the whole range, read only. */
export async function previewMilestoneCosmetics(
  pg: AugmentedPool,
  { afterUserId, maxUserId, milestoneKey }: UserRange & { milestoneKey?: string }
): Promise<BackfillPreview> {
  const query = await pg.cancellableQuery<BackfillPreview>(
    `
    SELECT count(DISTINCT ucm."userId")::int AS users, count(*)::int AS rows
    FROM "UserCreatorMilestone" ucm
    JOIN (${milestoneCosmeticsSql}) mc ON mc."milestoneKey" = ucm."milestoneKey"
    ${joinMilestoneGrantableUserSql('u', 'ucm."userId"')}
    WHERE ($3::text IS NULL OR mc."milestoneKey" = $3)
      AND ucm."userId" > $1 AND ($2::int IS NULL OR ucm."userId" <= $2)
      AND NOT EXISTS (
        SELECT 1 FROM "UserCosmetic" uc
        WHERE uc."userId" = ucm."userId" AND uc."cosmeticId" = mc."cosmeticId"
          AND uc."claimKey" = mc."milestoneKey"
      )
    `,
    [afterUserId, maxUserId ?? null, milestoneKey ?? null]
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

import { env } from '~/env/server';
import { pgDbRead } from '~/server/db/pgDb';
import { REACTION_METRICS } from '~/server/services/metric-reconciliation.service';

/**
 * Compensating-event repair for image reaction metrics.
 *
 * Kept out of `metric-reconciliation.service` because that module is read-only by
 * construction and this one writes to ClickHouse. The detector must stay safe to
 * run anywhere; this must not.
 *
 * Writes are gated on `METRIC_REACTION_REPAIR_ENABLED`, which defaults to false —
 * merging this cannot start mutating production. With the flag off the diff is
 * still computed and returned, so the shape and volume of what it *would* write
 * are observable before anything is enabled.
 */

const REACTION_METRIC_LIST = REACTION_METRICS.map((m) => `'${m}'`).join(',');
const CH_MEMORY_LIMIT = 4_000_000_000;
const ENTITY_TYPE = 'Image';

export type ReactionRepairResult = {
  imagesRequested: number;
  imagesLive: number;
  /** Requested images no longer in Postgres. Their removals are skipped, not counted. */
  imagesSkippedDeleted: number;
  additions: number;
  removals: number;
  pairsSkippedExcludedUser: number;
  /** False when the env gate is off or there was nothing to write. */
  inserted: boolean;
  durationMs: number;
};

type EventRow = {
  entityType: string;
  entityId: number;
  userId: number;
  metricType: string;
  metricValue: number;
  createdAt: string;
};

const key = (imageId: number, userId: number, reaction: string) =>
  `${imageId}|${userId}|${reaction}`;

/** ClickHouse DateTime's native text format. Avoids relying on best-effort ISO parsing. */
function toChDateTime(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Rebuilds the compensating events needed to make ClickHouse agree with Postgres
 * for `imageIds`. Safe to re-run: `entityMetricEvents_month` is a ReplacingMergeTree
 * ordered by (entityType, entityId, metricType, userId, createdAt), so an addition
 * replayed at the reaction's own timestamp collapses onto the existing row instead
 * of double-counting.
 */
export async function repairReactionMetrics(
  imageIds: number[],
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<ReactionRepairResult> {
  const startedAt = Date.now();
  const empty: ReactionRepairResult = {
    imagesRequested: imageIds.length,
    imagesLive: 0,
    imagesSkippedDeleted: 0,
    additions: 0,
    removals: 0,
    pairsSkippedExcludedUser: 0,
    inserted: false,
    durationMs: 0,
  };
  if (!imageIds.length) return { ...empty, durationMs: Date.now() - startedAt };

  const { clickhouse } = await import('~/server/clickhouse/client');
  if (!clickhouse) throw new Error('clickhouse client unavailable');

  /**
   * Removals are stamped strictly before Postgres is read, so a reaction created
   * during or after the read outranks this `-1` under argMax rather than being
   * cancelled by it. Captured before the first query for that reason.
   */
  const removalAt = toChDateTime(new Date(Date.now() - 1000));

  const { rows: liveRows } = await pgDbRead.query<{ id: number }>(
    'SELECT id FROM "Image" WHERE id = ANY($1::int[])',
    [imageIds]
  );
  const liveIds = liveRows.map((r) => r.id);
  const imagesSkippedDeleted = imageIds.length - liveIds.length;
  if (!liveIds.length) {
    return { ...empty, imagesSkippedDeleted, durationMs: Date.now() - startedAt };
  }

  /**
   * `createdAt` is formatted in SQL, not JS. It is `timestamp without time zone`
   * holding UTC, and the pg driver parses that type using the process timezone —
   * reading it into a Date and formatting it back would shift every repaired
   * event by the pod's offset.
   */
  const { rows: pgPairs } = await pgDbRead.query<{
    imageId: number;
    userId: number;
    reaction: string;
    createdAt: string;
  }>(
    `SELECT "imageId", "userId", reaction::text AS reaction,
            to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS') AS "createdAt"
       FROM "ImageReaction" WHERE "imageId" = ANY($1::int[])`,
    [liveIds]
  );

  const excludedRows = await clickhouse.$query<{ userId: number }>`
    SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1
  `;
  const excluded = new Set(excludedRows.map((r) => Number(r.userId)));

  const chPairs = await clickhouse.$query<{
    entityId: number;
    userId: number;
    metricType: string;
  }>`
    SELECT entityId, userId, metricType
      FROM entityMetricUserState_v3
     WHERE entityType = 'Image'
       AND entityId IN (${liveIds})
       AND metricType IN (${REACTION_METRIC_LIST})
     GROUP BY entityId, userId, metricType
    HAVING argMaxMerge(latest) > 0
    SETTINGS max_memory_usage = ${CH_MEMORY_LIMIT}
  `;

  const pgSet = new Set(pgPairs.map((r) => key(r.imageId, r.userId, r.reaction)));
  const chSet = new Set(
    chPairs.map((r) => key(Number(r.entityId), Number(r.userId), r.metricType))
  );

  const values: EventRow[] = [];
  let additions = 0;
  let removals = 0;
  let pairsSkippedExcludedUser = 0;

  for (const r of pgPairs) {
    if (excluded.has(r.userId)) {
      pairsSkippedExcludedUser++;
      continue;
    }
    if (chSet.has(key(r.imageId, r.userId, r.reaction))) continue;
    values.push({
      entityType: ENTITY_TYPE,
      entityId: r.imageId,
      userId: r.userId,
      metricType: r.reaction,
      metricValue: 1,
      createdAt: r.createdAt,
    });
    additions++;
  }

  for (const r of chPairs) {
    const entityId = Number(r.entityId);
    const userId = Number(r.userId);
    if (excluded.has(userId)) {
      pairsSkippedExcludedUser++;
      continue;
    }
    if (pgSet.has(key(entityId, userId, r.metricType))) continue;
    values.push({
      entityType: ENTITY_TYPE,
      entityId,
      userId,
      metricType: r.metricType,
      metricValue: -1,
      createdAt: removalAt,
    });
    removals++;
  }

  const shouldWrite = env.METRIC_REACTION_REPAIR_ENABLED && !dryRun && values.length > 0;
  if (shouldWrite) {
    await clickhouse.insert({
      table: 'entityMetricEvents_month',
      values,
      format: 'JSONEachRow',
      clickhouse_settings: { max_memory_usage: String(CH_MEMORY_LIMIT) },
    });
  }

  return {
    imagesRequested: imageIds.length,
    imagesLive: liveIds.length,
    imagesSkippedDeleted,
    additions,
    removals,
    pairsSkippedExcludedUser,
    inserted: shouldWrite,
    durationMs: Date.now() - startedAt,
  };
}

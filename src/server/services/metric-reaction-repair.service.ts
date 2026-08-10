import { pgDbRead } from '~/server/db/pgDb';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { REACTION_METRICS } from '~/server/services/metric-reconciliation.service';

/**
 * Compensating-event repair for image reaction metrics.
 *
 * Kept out of `metric-reconciliation.service` because that module is read-only by
 * construction and this one writes to ClickHouse. The detector must stay safe to
 * run anywhere; this must not.
 *
 * Gated on the `metric-reaction-repair` Flipt flag, which is off unless someone
 * turns it on (and reads false when Flipt is unreachable) — merging this cannot
 * start mutating production. The gate is checked before any I/O, not just before
 * the insert: a detection means ClickHouse is already unhealthy, so running the
 * read load anyway would add load at the worst moment.
 *
 * That leaves no free preview, so callers wanting the diff without the writes must
 * ask for it explicitly with `dryRun` — which reads normally and never inserts. The
 * nightly job does exactly that while the flag is off (see the hook registration in
 * `jobs/metric-reconciliation-audit`), because otherwise enabling the flag would be
 * the first time anyone sees what it writes.
 */

const REACTION_METRIC_LIST = REACTION_METRICS.map((m) => `'${m}'`).join(',');
const CH_MEMORY_LIMIT = 4_000_000_000;
const ENTITY_TYPE = 'Image';

/**
 * A detector breach during a real CDC outage flags essentially every image in the
 * hour. Measured on one such hour: 16,828 images / 1,065,041 reaction rows / up to
 * 15,509 rows on a single image. Unbatched that is a ~1M-row read into node memory,
 * a 16.8k-element interpolated `IN (...)`, and a single ~1M-object insert — issued
 * at exactly the moment ClickHouse is least healthy. Batching bounds every one of
 * those; the cap bounds total work per invocation and reports what it dropped
 * rather than silently truncating.
 */
const BATCH_SIZE = 250;
const MAX_IMAGES_PER_RUN = 5_000;

export type ReactionRepairResult = {
  imagesRequested: number;
  /** Images beyond MAX_IMAGES_PER_RUN, not processed. Non-zero means re-run. */
  imagesSkippedOverCap: number;
  imagesLive: number;
  /** Requested images no longer in Postgres. Their removals are skipped, not counted. */
  imagesSkippedDeleted: number;
  additions: number;
  removals: number;
  /** Distinct (image, user, reaction) pairs skipped because the user is excluded. */
  pairsSkippedExcludedUser: number;
  /** True only if at least one batch was actually written. */
  inserted: boolean;
  /** Why nothing was written, when nothing was. */
  skippedReason?: 'disabled' | 'dry-run' | 'no-changes';
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
  const base: ReactionRepairResult = {
    imagesRequested: imageIds.length,
    imagesSkippedOverCap: 0,
    imagesLive: 0,
    imagesSkippedDeleted: 0,
    additions: 0,
    removals: 0,
    pairsSkippedExcludedUser: 0,
    inserted: false,
    durationMs: 0,
  };
  const done = (r: Partial<ReactionRepairResult>) => ({
    ...base,
    ...r,
    durationMs: Date.now() - startedAt,
  });

  /**
   * Gate before any I/O, not just before the insert. A detection means ClickHouse
   * is already unhealthy, and running the full read load on every breach while the
   * writes are disabled is the worst time to be adding load. `dryRun` is the
   * explicit operator opt-in for measuring the diff without arming writes.
   */
  if (!dryRun && !(await isFlipt(FLIPT_FEATURE_FLAGS.METRIC_REACTION_REPAIR)))
    return done({ skippedReason: 'disabled' });
  if (!imageIds.length) return done({ skippedReason: 'no-changes' });

  const { clickhouse } = await import('~/server/clickhouse/client');
  if (!clickhouse) throw new Error('clickhouse client unavailable');

  const targets = imageIds.slice(0, MAX_IMAGES_PER_RUN);
  const imagesSkippedOverCap = imageIds.length - targets.length;

  /**
   * Derived from the replica's replay position rather than wall clock. `pgDbRead`
   * is a replica, and Debezium reads the primary's WAL — so a reaction committed
   * within the replication lag is already in ClickHouse but not yet visible here.
   * It would appear only in `chPairs`, look like a phantom, and earn a `-1`. A
   * hardcoded `now() - 1s` is only safe while lag stays under a second; anchoring
   * to the replay position means the stamp is always older than anything the
   * replica cannot yet see, whatever the lag. On a primary the function returns
   * NULL and this falls back to `now()`.
   *
   * Cost of a now-ish stamp, which matters before anyone runs another BULK repair:
   * consumers doing a rolling window over `createdAt` see the `-1` but not the old
   * `+1` it cancels, so historical corrections read as fresh un-reactions. Measured
   * after the 2026-08-07 backfill: 3,197,222 removals on one day against a ~18k/day
   * baseline, leaving 17,247 orphaned removals inside the image leaderboards' 30-day
   * window. `original createdAt + 1s` would avoid both that and the ReplacingMergeTree
   * key collision that stamping at the original `createdAt` exactly would cause.
   */
  const { rows: clockRows } = await pgDbRead.query<{ removalAt: string }>(
    `SELECT to_char(
              COALESCE(pg_last_xact_replay_timestamp(), now()) AT TIME ZONE 'utc'
                - interval '1 second',
              'YYYY-MM-DD HH24:MI:SS') AS "removalAt"`
  );
  const removalAt = clockRows[0].removalAt;

  const excludedRows = await clickhouse.$query<{ userId: number }>`
    SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1
    SETTINGS max_memory_usage = ${CH_MEMORY_LIMIT}
  `;
  const excluded = new Set(excludedRows.map((r) => Number(r.userId)));

  let imagesLive = 0;
  let additions = 0;
  let removals = 0;
  let inserted = false;
  const skippedPairs = new Set<string>();

  for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
    const batch = targets.slice(offset, offset + BATCH_SIZE);

    const { rows: liveRows } = await pgDbRead.query<{ id: number }>(
      'SELECT id FROM "Image" WHERE id = ANY($1::int[])',
      [batch]
    );
    const liveIds = liveRows.map((r) => r.id);
    if (!liveIds.length) continue;
    imagesLive += liveIds.length;

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
    for (const r of pgPairs) {
      const k = key(r.imageId, r.userId, r.reaction);
      if (excluded.has(r.userId)) {
        skippedPairs.add(k);
        continue;
      }
      if (chSet.has(k)) continue;
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
      const k = key(entityId, userId, r.metricType);
      if (excluded.has(userId)) {
        skippedPairs.add(k);
        continue;
      }
      if (pgSet.has(k)) continue;
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

    if (!dryRun && values.length > 0) {
      await clickhouse.insert({
        table: 'entityMetricEvents_month',
        values,
        format: 'JSONEachRow',
        clickhouse_settings: { max_memory_usage: String(CH_MEMORY_LIMIT) },
      });
      inserted = true;
    }
  }

  return done({
    imagesSkippedOverCap,
    imagesLive,
    imagesSkippedDeleted: targets.length - imagesLive,
    additions,
    removals,
    pairsSkippedExcludedUser: skippedPairs.size,
    inserted,
    skippedReason: inserted ? undefined : dryRun ? 'dry-run' : 'no-changes',
  });
}

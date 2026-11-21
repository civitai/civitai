import { Prisma } from '@prisma/client';
import { countableImageSql } from '~/server/common/image-visibility';
import { dbRead, dbWrite } from '~/server/db/client';

/**
 * ModelVersionMetric.imageCount, kept current by counting each hour of newly published posts
 * exactly once, a day after the hour closes, and adding the result. Recounting a version's whole
 * history was what made the old writer too expensive to run (getImageTasks, model.metrics.ts).
 * The watermark advances in the same transaction as the counts, so a repeated, crashed or
 * concurrent run can neither skip an hour nor count one twice. The job never subtracts:
 * removals after the count are drift, repaired per version with `recountVersions`.
 */

export const WATERMARK_KEY = 'model-image-count:watermark';
export const HOUR_MS = 60 * 60 * 1000;
/** Gives scanning and review a day to settle before an hour is read. */
export const COUNT_DELAY_MS = 24 * HOUR_MS;
export const MAX_HOURS_PER_RUN = 6;
/** The 1-minute model metric job upserts MVM in ascending batches of this size; matching it keeps the two from deadlocking. */
const APPLY_BATCH = 100;
const MAX_REPLICA_LAG_SECONDS = 600;
/** Covers waiting on the advisory lock behind a run or a finalize batch that holds it. */
export const LOCK_WAIT_MS = 180_000;

export type Watermark = { hour: number; paused?: boolean };
export type VersionCount = { modelVersionId: number; count: number };

/** Hour starts (epoch ms) that are due after `watermark`, oldest first. */
export function dueHours(watermarkHour: number, now: number, max = MAX_HOURS_PER_RUN) {
  const hours: number[] = [];
  for (
    let h = watermarkHour;
    h + HOUR_MS <= now - COUNT_DELAY_MS && hours.length < max;
    h += HOUR_MS
  )
    hours.push(h);
  return hours;
}

export const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * Per-version counts of countable images on posts matching `where` (over `"Post" p`, `"Image" i`,
 * `"ImageResourceNew" ir`). The model owner's own images count: a product decision (2026-11-21),
 * where the writer this replaces counted only other people's.
 */
export function countImagesSql(where: Prisma.Sql) {
  return Prisma.sql`
    SELECT ir."modelVersionId", count(*)::int AS "count"
    FROM "Post" p
    JOIN "Image" i ON i."postId" = p.id
    JOIN "ImageResourceNew" ir ON ir."imageId" = i.id
    WHERE ${where}
      AND ${countableImageSql()}
    GROUP BY ir."modelVersionId"
  `;
}

export const hourWindowSql = (hour: number) =>
  Prisma.sql`p."publishedAt" >= ${new Date(hour)} AND p."publishedAt" < ${new Date(
    hour + HOUR_MS
  )}`;

/**
 * Adds `counts` to imageCount, ascending by version. A version deleted since the read is dropped
 * by the join rather than failing the whole hour on its foreign key.
 */
export function addCountsSql(counts: VersionCount[]) {
  return Prisma.sql`
    INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount", "updatedAt")
    SELECT u.id, u.c, now()
    FROM unnest(${counts.map((c) => c.modelVersionId)}::int[], ${counts.map(
    (c) => c.count
  )}::int[]) AS u(id, c)
    JOIN "ModelVersion" mv ON mv.id = u.id
    ORDER BY u.id
    ON CONFLICT ("modelVersionId") DO UPDATE
      SET "imageCount" = "ModelVersionMetric"."imageCount" + EXCLUDED."imageCount", "updatedAt" = now()
  `;
}

/** Sets imageCount outright, touching only rows whose value changes so the rollups re-read only those. */
export function setCountsSql(counts: VersionCount[]) {
  return Prisma.sql`
    INSERT INTO "ModelVersionMetric" ("modelVersionId", "imageCount", "updatedAt")
    SELECT u.id, u.c, now()
    FROM unnest(${counts.map((c) => c.modelVersionId)}::int[], ${counts.map(
    (c) => c.count
  )}::int[]) AS u(id, c)
    JOIN "ModelVersion" mv ON mv.id = u.id
    ORDER BY u.id
    ON CONFLICT ("modelVersionId") DO UPDATE
      SET "imageCount" = EXCLUDED."imageCount", "updatedAt" = now()
      WHERE "ModelVersionMetric"."imageCount" IS DISTINCT FROM EXCLUDED."imageCount"
  `;
}

export const sortedBatches = (counts: VersionCount[], size = APPLY_BATCH) => {
  const sorted = counts
    .filter((c) => c.count > 0)
    .sort((a, b) => a.modelVersionId - b.modelVersionId);
  const batches: VersionCount[][] = [];
  for (let i = 0; i < sorted.length; i += size) batches.push(sorted.slice(i, i + size));
  return batches;
};

type Tx = Prisma.TransactionClient;

export async function lockImageCount(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('model-image-count'))`;
}

export async function readKeyValue<T>(tx: Tx, key: string) {
  const rows = await tx.$queryRaw<{ value: T }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${key} FOR UPDATE
  `;
  return rows[0]?.value;
}

export async function writeKeyValue(tx: Tx, key: string, value: unknown) {
  await tx.$executeRaw`
    INSERT INTO "KeyValue" (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Seconds the replica is behind, or 0 on a primary. */
export async function replicaLagSeconds() {
  const [row] = await dbRead.$queryRaw<{ lag: number | null }[]>`
    SELECT CASE WHEN pg_is_in_recovery()
      THEN EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::float
      ELSE 0 END AS lag
  `;
  return row?.lag ?? 0;
}

export type HourResult = { hour: number; versions: number; images: number } | { skipped: string };

/** Counts the hour at the watermark and advances it. Writes nothing unless the watermark still says that hour. */
export async function countNextHour(now = Date.now()): Promise<HourResult> {
  const watermark = await dbRead.$queryRaw<{ value: Watermark }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${WATERMARK_KEY}
  `.then((r) => r[0]?.value);
  if (!watermark) return { skipped: 'no watermark (backfill not finalized)' };
  if (watermark.paused) return { skipped: 'paused' };
  const [hour] = dueHours(watermark.hour, now, 1);
  if (hour === undefined) return { skipped: 'nothing due' };

  const lag = await replicaLagSeconds();
  if (lag > MAX_REPLICA_LAG_SECONDS) return { skipped: `replica ${Math.round(lag)}s behind` };

  const counts = await dbRead.$queryRaw<VersionCount[]>(countImagesSql(hourWindowSql(hour)));

  return dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const current = await readKeyValue<Watermark>(tx, WATERMARK_KEY);
      if (!current || current.paused || current.hour !== hour)
        return { skipped: 'watermark moved' } as HourResult;
      for (const batch of sortedBatches(counts)) await tx.$executeRaw(addCountsSql(batch));
      await writeKeyValue(tx, WATERMARK_KEY, { ...current, hour: hour + HOUR_MS });
      return {
        hour,
        versions: counts.length,
        images: counts.reduce((sum, c) => sum + c.count, 0),
      };
    },
    { timeout: LOCK_WAIT_MS }
  );
}

/** Versions with more IRN rows than this need the chunked walk, not a one-shot recount. */
export const RECOUNT_MAX_IRN_ROWS = 200_000;

/**
 * Sets imageCount to a fresh count over every post published before the watermark, for a ban, a
 * mass block or a reported farm. Counts on the replica and writes under the lock; if the
 * watermark moved in between, the count is stale by an hour and is thrown away.
 */
export async function recountVersions(versionIds: number[]) {
  const ids = [...new Set(versionIds)].sort((a, b) => a - b);
  const sizes = await dbRead.$queryRaw<{ id: number; rows: number }[]>`
    SELECT "modelVersionId" AS id, count(*)::int AS rows
    FROM "ImageResourceNew" WHERE "modelVersionId" = ANY(${ids}::int[])
    GROUP BY 1
  `;
  const tooBig = sizes.filter((s) => s.rows > RECOUNT_MAX_IRN_ROWS).map((s) => s.id);
  if (tooBig.length) throw new Error(`Too many image rows to recount: ${tooBig.join(', ')}`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const watermark = await dbRead.$queryRaw<{ value: Watermark }[]>`
      SELECT value FROM "KeyValue" WHERE key = ${WATERMARK_KEY}
    `.then((r) => r[0]?.value);
    if (!watermark) throw new Error('No watermark: the backfill has not been finalized');
    const counts = await dbRead.$queryRaw<VersionCount[]>(
      countImagesSql(
        Prisma.sql`ir."modelVersionId" = ANY(${ids}::int[]) AND p."publishedAt" < ${new Date(
          watermark.hour
        )}`
      )
    );
    const byId = new Map(counts.map((c) => [c.modelVersionId, c.count]));
    const done = await dbWrite.$transaction(
      async (tx) => {
        await lockImageCount(tx);
        const current = await readKeyValue<Watermark>(tx, WATERMARK_KEY);
        if (current?.hour !== watermark.hour) return false;
        await tx.$executeRaw(
          setCountsSql(ids.map((id) => ({ modelVersionId: id, count: byId.get(id) ?? 0 })))
        );
        return true;
      },
      { timeout: LOCK_WAIT_MS }
    );
    if (done) return ids.map((id) => ({ modelVersionId: id, count: byId.get(id) ?? 0 }));
  }
  throw new Error('Watermark kept moving; try again');
}

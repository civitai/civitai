import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import {
  COUNT_DELAY_MS,
  countImagesSql,
  floorHour,
  LOCK_WAIT_MS,
  lockImageCount,
  readKeyValue,
  setCountsSql,
  WATERMARK_KEY,
  writeKeyValue,
  type VersionCount,
  type Watermark,
} from '~/server/metrics/model-image-count';

/**
 * One-off rebuild of ModelVersionMetric.imageCount from history, staged in the unused
 * `ModelMetricDaily` table so the frozen values keep serving until finalize swaps them in.
 * The order is enforced here, not in a runbook: finalize refuses until every image id up to
 * `j0` is staged, and the job stays inert until finalize writes the watermark, last.
 */

export const PROGRESS_KEY = 'model-image-count:backfill';
export const STAGED_PREFIX = 'imgbf:';
/** Pre-finalize imageCount of every row finalize visited: the rollback point. */
export const PREV_TYPE = 'imgbf:prev';

export type Progress = {
  /** Posts published before this hour are the backfill's; the job counts from it. */
  w0: number;
  /** The highest Image id when the backfill started. */
  j0: number;
  ranges: [number, number][];
  finalizeCursor?: number;
  finalized?: boolean;
  revertCursor?: number;
};

type Range = [number, number];

/** Merges inclusive id ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** The parts of `[1, end]` no range covers. */
export function coverageGaps(ranges: Range[], end: number): Range[] {
  const gaps: Range[] = [];
  let next = 1;
  for (const [a, b] of mergeRanges(ranges)) {
    if (a > next) gaps.push([next, Math.min(a - 1, end)]);
    next = Math.max(next, b + 1);
    if (next > end) break;
  }
  if (next <= end) gaps.push([next, end]);
  return gaps.filter(([a, b]) => a <= b);
}

export const overlaps = (ranges: Range[], [a, b]: Range) =>
  ranges.some(([x, y]) => a <= y && x <= b);

const stagedWhere = Prisma.sql`type LIKE ${STAGED_PREFIX + '%'} AND type <> ${PREV_TYPE}`;

async function readProgress() {
  return dbRead.$queryRaw<{ value: Progress }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${PROGRESS_KEY}
  `.then((r) => r[0]?.value);
}

export async function startBackfill(now = Date.now()) {
  const [top] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id FROM "Image" ORDER BY id DESC LIMIT 1
  `;
  return dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const existing = await readKeyValue<Progress>(tx, PROGRESS_KEY);
      if (existing) return existing;
      const progress: Progress = { w0: floorHour(now - COUNT_DELAY_MS), j0: top.id, ranges: [] };
      await writeKeyValue(tx, PROGRESS_KEY, progress);
      return progress;
    },
    { timeout: LOCK_WAIT_MS }
  );
}

/**
 * Counts `[start, end]` of Image ids in chunks and stages the sum in one write. A range that
 * overlaps one already staged is refused, so a rerun never double-counts; a chunk that fails is
 * left out of the recorded ranges, so finalize sees the gap.
 */
export async function stageRange({
  start,
  end,
  batchSize,
  concurrency,
  dryRun,
  runContext,
}: {
  start: number;
  end: number;
  batchSize: number;
  concurrency: number;
  dryRun: boolean;
  runContext: { on: (event: 'close', listener: () => void) => void };
}) {
  const progress = await readProgress();
  if (!progress) throw new Error('Start the backfill first');
  end = Math.min(end, progress.j0);
  if (start > end) return { staged: 0, versions: 0, ranges: [] as Range[] };
  if (overlaps(progress.ranges, [start, end])) throw new Error('Range overlaps one already staged');

  const totals = new Map<number, number>();
  const done: Range[] = [];
  await dataProcessor({
    params: { start, end, batchSize, concurrency },
    runContext,
    rangeFetcher: async () => ({ start, end }),
    processor: async ({ start: a, end: b }) => {
      const counts = await dbRead.$queryRaw<VersionCount[]>(
        countImagesSql(
          Prisma.sql`i.id BETWEEN ${a} AND ${b} AND p."publishedAt" < ${new Date(progress.w0)}`
        )
      );
      for (const c of counts)
        totals.set(c.modelVersionId, (totals.get(c.modelVersionId) ?? 0) + c.count);
      done.push([a, b]);
    },
  });

  const images = [...totals.values()].reduce((s, c) => s + c, 0);
  if (dryRun || !done.length)
    return { staged: images, versions: totals.size, ranges: mergeRanges(done) };

  // Unique per write: written ranges never overlap, so a gap left by a failed chunk can be
  // restaged under its own key without colliding with the call it fell out of.
  const first = done.reduce((m, r) => Math.min(m, r[0]), Infinity);
  const last = done.reduce((m, r) => Math.max(m, r[1]), -Infinity);
  const type = `${STAGED_PREFIX}${first}-${last}`;
  await dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const current = await readKeyValue<Progress>(tx, PROGRESS_KEY);
      if (!current || current.w0 !== progress.w0) throw new Error('Backfill progress changed');
      if (done.some((r) => overlaps(current.ranges, r)))
        throw new Error('Range was staged concurrently');
      for (const rows of chunk([...totals.entries()], 5000))
        await tx.$executeRaw`
          INSERT INTO "ModelMetricDaily" ("modelId", "modelVersionId", type, date, count)
          SELECT mv."modelId", u.id, ${type}, ${new Date(progress.w0)}::date, u.c
          FROM unnest(${rows.map((r) => r[0])}::int[], ${rows.map((r) => r[1])}::int[]) AS u(id, c)
          JOIN "ModelVersion" mv ON mv.id = u.id
        `;
      await writeKeyValue(tx, PROGRESS_KEY, {
        ...current,
        ranges: mergeRanges([...current.ranges, ...done]),
      });
    },
    { timeout: LOCK_WAIT_MS }
  );
  return { staged: images, versions: totals.size, ranges: mergeRanges(done) };
}

export async function backfillStatus() {
  const progress = await readProgress();
  const watermark = await dbRead.$queryRaw<{ value: Watermark }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${WATERMARK_KEY}
  `.then((r) => r[0]?.value);
  return {
    progress: progress && { ...progress, ranges: mergeRanges(progress.ranges) },
    gaps: progress ? coverageGaps(progress.ranges, progress.j0) : null,
    watermark,
  };
}

/**
 * Swaps `limit` versions' staged totals into imageCount, ascending from the cursor. A version
 * with a count and nothing staged goes to 0: its old value predates the gate. Before a row
 * changes, its old value is kept as a `PREV_TYPE` row; ON CONFLICT DO NOTHING keeps the first
 * one, so a resumed finalize cannot overwrite the rollback point. Call it about once a minute:
 * every changed row bumps updatedAt, which the 1-minute model metric job then re-aggregates.
 */
export async function finalizeBatch(limit: number) {
  return dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const progress = await readKeyValue<Progress>(tx, PROGRESS_KEY);
      if (!progress) throw new Error('No backfill');
      if (progress.finalized) throw new Error('Already finalized');
      if (await readKeyValue<Watermark>(tx, WATERMARK_KEY))
        throw new Error('Watermark exists: the job owns the counts');
      const gaps = coverageGaps(progress.ranges, progress.j0);
      if (gaps.length) throw new Error(`Unstaged image ids: ${JSON.stringify(gaps.slice(0, 5))}`);
      const [mixed] = await tx.$queryRaw<{ type: string }[]>`
        SELECT type FROM "ModelMetricDaily"
        WHERE ${stagedWhere} AND date <> ${new Date(progress.w0)}::date LIMIT 1
      `;
      if (mixed) throw new Error(`Staged rows from another cutoff: ${mixed.type}`);

      const cursor = progress.finalizeCursor ?? 0;
      const ids = await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM (
          (SELECT DISTINCT "modelVersionId" AS id FROM "ModelMetricDaily"
            WHERE ${stagedWhere} AND "modelVersionId" > ${cursor} ORDER BY 1 LIMIT ${limit})
          UNION
          (SELECT "modelVersionId" FROM "ModelVersionMetric"
            WHERE "imageCount" > 0 AND "modelVersionId" > ${cursor} ORDER BY 1 LIMIT ${limit})
        ) t ORDER BY id LIMIT ${limit}
      `.then((r) => r.map((x) => x.id));

      if (ids.length) {
        const rows = await tx.$queryRaw<{ id: number; old: number; next: number }[]>`
          SELECT u.id, COALESCE(mvm."imageCount", 0)::int AS old, COALESCE(s.c, 0)::int AS next
          FROM unnest(${ids}::int[]) AS u(id)
          LEFT JOIN "ModelVersionMetric" mvm ON mvm."modelVersionId" = u.id
          LEFT JOIN (
            SELECT "modelVersionId", SUM(count) AS c FROM "ModelMetricDaily"
            WHERE ${stagedWhere} AND "modelVersionId" = ANY(${ids}::int[])
            GROUP BY 1
          ) s ON s."modelVersionId" = u.id
        `;
        // Every visited row, changed or not, so a revert also takes back what the job added since.
        await tx.$executeRaw`
          INSERT INTO "ModelMetricDaily" ("modelId", "modelVersionId", type, date, count)
          SELECT mv."modelId", u.id, ${PREV_TYPE}, ${new Date(progress.w0)}::date, u.c
          FROM unnest(${rows.map((r) => r.id)}::int[], ${rows.map((r) => r.old)}::int[]) AS u(id, c)
          JOIN "ModelVersion" mv ON mv.id = u.id
          ON CONFLICT DO NOTHING
        `;
        const changed = rows.filter((r) => r.old !== r.next);
        if (changed.length) {
          await tx.$executeRaw(
            setCountsSql(changed.map((r) => ({ modelVersionId: r.id, count: r.next })))
          );
        }
      }

      const finished = ids.length < limit;
      await writeKeyValue(tx, PROGRESS_KEY, {
        ...progress,
        finalizeCursor: ids.length ? ids[ids.length - 1] : cursor,
        finalized: finished || undefined,
      });
      if (finished)
        await writeKeyValue(tx, WATERMARK_KEY, { hour: progress.w0 } satisfies Watermark);
      return { versions: ids.length, finished };
    },
    { timeout: LOCK_WAIT_MS }
  );
}

/** Pauses the job, then restores `limit` versions' pre-finalize counts, ascending from the cursor. */
export async function revertBatch(limit: number) {
  return dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const progress = await readKeyValue<Progress>(tx, PROGRESS_KEY);
      if (!progress) throw new Error('No backfill');
      const watermark = await readKeyValue<Watermark>(tx, WATERMARK_KEY);
      if (watermark && !watermark.paused)
        await writeKeyValue(tx, WATERMARK_KEY, { ...watermark, paused: true });
      const cursor = progress.revertCursor ?? 0;
      const prev = await tx.$queryRaw<VersionCount[]>`
        SELECT "modelVersionId", SUM(count)::int AS count FROM "ModelMetricDaily"
        WHERE type = ${PREV_TYPE} AND "modelVersionId" > ${cursor}
        GROUP BY 1 ORDER BY 1 LIMIT ${limit}
      `;
      if (prev.length) await tx.$executeRaw(setCountsSql(prev));
      await writeKeyValue(tx, PROGRESS_KEY, {
        ...progress,
        revertCursor: prev.length ? prev[prev.length - 1].modelVersionId : cursor,
      });
      return { versions: prev.length, finished: prev.length < limit };
    },
    { timeout: LOCK_WAIT_MS }
  );
}

export async function setPaused(paused: boolean) {
  return dbWrite.$transaction(
    async (tx) => {
      await lockImageCount(tx);
      const watermark = await readKeyValue<Watermark>(tx, WATERMARK_KEY);
      if (!watermark) throw new Error('No watermark');
      const next = { ...watermark, paused: paused || undefined };
      await writeKeyValue(tx, WATERMARK_KEY, next);
      return next;
    },
    { timeout: LOCK_WAIT_MS }
  );
}

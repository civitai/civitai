import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { applyUserScoreUpdates, getScoreMultipliers } from '~/server/jobs/update-user-score';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * One-off backfill for the creator-score `images` category — a single command.
 * =============================================================================
 *
 * The image score was silently 0 for everyone (the cron read the stale
 * `image_metrics_user` table). The fix reads `entityMetricDailyAgg_v2`, but it's
 * incremental — only owners with recent engagement get revisited. This sweep
 * recomputes EVERY image owner's `images` score (and `total`).
 *
 * Image-driven, so it scans the slow v2 view ONCE in entityId ranges (~135 range
 * scans) instead of re-querying it per owner (~23k random IN lookups, ~60h). One
 * pass: range-scan v2 for engaged images, roll reactions/comments up per owner in
 * memory, then write each owner's score + total and stamp `imageScoreRecomputedAt`.
 *
 * Defaults to a DRY RUN (scan + count owners, no writes) — pass &dryRun=false to
 * actually write. Run it (drive from the no-timeout dev server, which talks to
 * prod; keep the client connected — nohup/screen):
 *   GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN&dryRun=false
 *   optional: &concurrency=3 &batchSize=1000000  (default already 1,000,000 = ~135 v2
 *   scans; a SMALLER window means MORE/slower scans, not fewer)
 *
 * Full re-sweep (ignore prior stamps, recompute EVERY owner, and set the
 * `update-user-score:images` cron checkpoint to hand off cleanly):
 *   GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN&dryRun=false&force=true
 *
 * Idempotent + resumable: owners already stamped with `imageScoreRecomputedAt` are
 * always skipped, so a re-run only fills in the rest (never recomputes finished
 * users). Run the FULL range (default) — a partial start/end gives partial scores
 * since an owner's images are spread across the id space.
 *
 * Auth via the existing `WebhookEndpoint(?token=...)` gate.
 */

const REACTION_TYPES = "'Like', 'Heart', 'Laugh', 'Cry'";

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(20).optional().default(3),
  batchSize: z.coerce.number().min(1).optional().default(1_000_000), // entityId window per v2 scan (~135 scans over the full id space; smaller = more, slower scans)
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  // preview: scan + count owners, write nothing.
  dryRun: booleanString().default(true),
  // full sweep: recompute + re-stamp EVERY owner, ignoring imageScoreRecomputedAt.
  // Use to establish a fresh baseline / reconcile drift for the incremental cron.
  force: booleanString().default(false),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const params = schema.parse(req.query);
  const { images: imageMultipliers } = await getScoreMultipliers();

  console.time('BACKFILL_IMAGE_SCORES');

  // Checkpoint the incremental cron will resume from after a full sweep. Taken
  // BEFORE the scan so no engagement between here and the checkpoint write is
  // missed by the cron (a few duplicate events during the sweep are harmless vs.
  // missing any).
  const sweepStartedAt = new Date();

  // Phase 1 — scan v2 once in entityId ranges, accumulate reactions/comments per
  // owner in memory (the `+=` is synchronous, so concurrent windows are race-free).
  const owners = new Map<number, { reactions: number; comments: number }>();
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (ctx) => {
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image"`
      );
      return { start: ctx.start, end: max ?? 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      const engaged = await clickhouse!.$query<{ imageId: number; reactions: number; comments: number }>(`
        SELECT entityId AS imageId,
          sumIf(total, metricType IN (${REACTION_TYPES})) AS reactions,
          sumIf(total, metricType = 'commentCount') AS comments
        FROM entityMetricDailyAgg_v2
        WHERE entityType = 'Image' AND entityId > ${start} AND entityId <= ${end}
        GROUP BY entityId
        HAVING reactions > 0 OR comments > 0
      `);
      if (!engaged.length) return;

      // imageId -> owner (Postgres is the authoritative owner map).
      const ownerByImage = new Map<number, number>();
      for (const ids of chunk(
        engaged.map((e) => e.imageId),
        10000
      )) {
        const q = await pgDbRead.cancellableQuery<{ id: number; userId: number }>(
          `SELECT id, "userId" FROM "Image" WHERE id = ANY($1::int[]) AND "userId" IS NOT NULL`,
          [ids]
        );
        cancelFns.push(q.cancel);
        for (const { id, userId } of await q.result()) ownerByImage.set(id, userId);
      }

      for (const { imageId, reactions, comments } of engaged) {
        const owner = ownerByImage.get(imageId);
        if (!owner) continue;
        const acc = owners.get(owner) ?? { reactions: 0, comments: 0 };
        acc.reactions += Number(reactions);
        acc.comments += Number(comments);
        owners.set(owner, acc);
      }
      console.log(`scan: imageId ${start}-${end} → ${engaged.length} engaged images`);
    },
  });

  if (params.dryRun) {
    console.timeEnd('BACKFILL_IMAGE_SCORES');
    return res
      .status(200)
      .json({ finished: true, dryRun: true, force: params.force, owners: owners.size, written: 0 });
  }

  // Phase 2 — write each owner's image score + recomputed total, stamp the marker.
  const stampedAt = new Date().toISOString();
  let written = 0;
  const writeTasks = chunk([...owners], 500).map((batch) => async () => {
    // Default: skip owners already backfilled, so a re-run resumes (fills in the
    // rest) instead of redoing finished users. force=true recomputes EVERYONE
    // (fresh baseline / drift reconcile for the incremental cron).
    let todo = batch;
    if (!params.force) {
      const stamped = await pgDbRead
        .cancellableQuery<{ id: number }>(
          `SELECT id FROM "User" WHERE id = ANY($1::int[]) AND (meta->'scores'->>'imageScoreRecomputedAt') IS NOT NULL`,
          [batch.map(([userId]) => userId)]
        )
        .then((q) => q.result());
      const skip = new Set(stamped.map((s) => s.id));
      todo = batch.filter(([userId]) => !skip.has(userId));
    }
    if (!todo.length) return;

    const records = todo.map(
      ([userId, { reactions, comments }]) =>
        [
          String(userId),
          { images: reactions * imageMultipliers.reactions + comments * imageMultipliers.comments },
        ] as [string, { images: number }]
    );
    await applyUserScoreUpdates(pgDbWrite, records);

    await pgDbWrite
      .cancellableQuery(
        `UPDATE "User"
         SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores,imageScoreRecomputedAt}', to_jsonb($1::text))
         WHERE id = ANY($2::int[])`,
        [stampedAt, todo.map(([userId]) => userId)]
      )
      .then((q) => q.result());

    written += todo.length;
  });
  await limitConcurrency(writeTasks, params.concurrency);

  // Hand off to the incremental cron: only after a genuine FULL sweep (force, real
  // writes, whole id range) is every stored score correct as of sweepStartedAt, so
  // the cron can safely sum deltas from there. A partial or resume run must NOT
  // advance the checkpoint (it would skip un-swept owners). Key mirrors the cron's
  // `${jobKey}:${category}` (see getJobDate in server/jobs/job.ts).
  const fullSweep = params.force && !params.dryRun && params.start === 0 && params.end === undefined;
  if (fullSweep) {
    await dbWrite.keyValue.upsert({
      where: { key: 'update-user-score:images' },
      create: { key: 'update-user-score:images', value: sweepStartedAt.getTime() },
      update: { value: sweepStartedAt.getTime() },
    });
  }

  console.timeEnd('BACKFILL_IMAGE_SCORES');
  res.status(200).json({
    finished: true,
    force: params.force,
    checkpointSet: fullSweep ? sweepStartedAt.toISOString() : null,
    owners: owners.size,
    written,
  });
});

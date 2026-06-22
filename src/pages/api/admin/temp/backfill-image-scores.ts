import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { applyUserScoreUpdates, getScoreMultipliers } from '~/server/jobs/update-user-score';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

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
 * memory, then write each owner's score + total and stamp `imagesBackfilledAt`.
 *
 * Run it (drive from the no-timeout dev server, which talks to prod; keep the
 * client connected — nohup/screen):
 *   GET /api/admin/temp/backfill-image-scores?token=$WEBHOOK_TOKEN
 *   optional: &concurrency=3 &batchSize=1000000 &skipMarked=true
 *
 * Idempotent: rewriting an owner produces the same score. `skipMarked=true` skips
 * owners already stamped (so a re-run only fills in the rest). Run the FULL range
 * (default) — a partial start/end gives partial scores since an owner's images
 * are spread across the id space.
 *
 * Auth via the existing `WebhookEndpoint(?token=...)` gate.
 */

const REACTION_TYPES = "'Like', 'Heart', 'Laugh', 'Cry'";

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(20).optional().default(3),
  batchSize: z.coerce.number().min(1).optional().default(1_000_000), // entityId window per v2 scan
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  // re-run helper: skip owners already stamped instead of rewriting them.
  skipMarked: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
  // preview: scan + count owners, write nothing.
  dryRun: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const params = schema.parse(req.query);
  const { images: imageMultipliers } = await getScoreMultipliers();

  console.time('BACKFILL_IMAGE_SCORES');

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
    return res.status(200).json({ finished: true, dryRun: true, owners: owners.size, written: 0 });
  }

  // Phase 2 — write each owner's image score + recomputed total, stamp the marker.
  const stampedAt = new Date().toISOString();
  let written = 0;
  const writeTasks = chunk([...owners], 500).map((batch) => async () => {
    const ids = batch.map(([userId]) => userId);

    if (params.skipMarked) {
      const stamped = await pgDbRead
        .cancellableQuery<{ id: number }>(
          `SELECT id FROM "User" WHERE id = ANY($1::int[]) AND (meta->'scores'->>'imagesBackfilledAt') IS NOT NULL`,
          [ids]
        )
        .then((q) => q.result());
      const skip = new Set(stamped.map((s) => s.id));
      batch = batch.filter(([userId]) => !skip.has(userId));
      if (!batch.length) return;
    }

    const records = batch.map(
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
         SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores,imagesBackfilledAt}', to_jsonb($1::text))
         WHERE id = ANY($2::int[])`,
        [stampedAt, batch.map(([userId]) => userId)]
      )
      .then((q) => q.result());

    written += batch.length;
  });
  await limitConcurrency(writeTasks, params.concurrency);

  console.timeEnd('BACKFILL_IMAGE_SCORES');
  res.status(200).json({ finished: true, owners: owners.size, written });
});

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

/**
 * One-off backfill for the creator-score `images` category.
 * =============================================================================
 *
 * The image score was silently 0 for everyone (the cron read the stale
 * `image_metrics_user` table). The fix reads `entityMetricDailyAgg_v2`, but it's
 * incremental — only owners with recent engagement get revisited. This sweep
 * recomputes EVERY image owner's `images` score (and `total`).
 *
 * Image-driven (not owner-driven) so it scans the slow v2 view ONCE in entityId
 * ranges instead of re-querying it per owner (~135 range scans vs ~23k random
 * IN lookups). Two phases:
 *
 *   scan  (default) - range-scan v2 for engaged images, roll up reactions/comments
 *                     per owner into the `temp_image_score_backfill` staging table.
 *                     Truncates + rebuilds, so it's idempotent (safe to re-run).
 *   apply           - read the staging table, write each owner's image score +
 *                     recomputed total, and stamp `meta.scores.imagesBackfilledAt`.
 *                     Skips owners already stamped, so it's resumable and never
 *                     recomputes a finished owner.
 *   reset           - drop the staging table.
 *
 * Typical run (drive from the no-timeout dev server, which talks to prod;
 * keep the client connected — nohup/screen):
 *   1) GET .../backfill-image-scores?token=...&action=scan
 *   2) GET .../backfill-image-scores?token=...&action=apply   (re-run freely; skips done)
 *
 * Auth via the existing `WebhookEndpoint(?token=...)` gate.
 */

const STAGING = 'temp_image_score_backfill';
const REACTION_TYPES = "'Like', 'Heart', 'Laugh', 'Cry'";

const schema = z.object({
  action: z.enum(['scan', 'apply', 'reset']).optional().default('scan'),
  concurrency: z.coerce.number().min(1).max(20).optional().default(3),
  // scan: width of the entityId (imageId) window per task.
  // apply: width of the userId window per task.
  batchSize: z.coerce.number().min(1).optional().default(1_000_000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });
  const params = schema.parse(req.query);

  if (params.action === 'reset') {
    await pgDbWrite.cancellableQuery(`DROP TABLE IF EXISTS ${STAGING}`).then((q) => q.result());
    return res.status(200).json({ action: 'reset', dropped: true });
  }

  const multipliers = await getScoreMultipliers();

  console.time('BACKFILL_IMAGE_SCORES');
  if (params.action === 'scan') await scan(res, params);
  else await apply(res, params, multipliers.images);
  console.timeEnd('BACKFILL_IMAGE_SCORES');

  res.status(200).json({ action: params.action, finished: true });
});

// Phase 1: roll engaged-image reactions/comments up per owner into staging.
async function scan(res: NextApiResponse, params: z.infer<typeof schema>) {
  await pgDbWrite
    .cancellableQuery(
      `CREATE TABLE IF NOT EXISTS ${STAGING} (
        user_id int PRIMARY KEY,
        reactions bigint NOT NULL DEFAULT 0,
        comments bigint NOT NULL DEFAULT 0
      )`
    )
    .then((q) => q.result());
  // Rebuild from scratch so re-running scan is idempotent.
  await pgDbWrite.cancellableQuery(`TRUNCATE ${STAGING}`).then((q) => q.result());

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
      // Engaged images in this entityId window (single sequential v2 range scan).
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

      // Roll up per owner for this window.
      const perOwner = new Map<number, { reactions: number; comments: number }>();
      for (const { imageId, reactions, comments } of engaged) {
        const owner = ownerByImage.get(imageId);
        if (!owner) continue;
        const acc = perOwner.get(owner) ?? { reactions: 0, comments: 0 };
        acc.reactions += Number(reactions);
        acc.comments += Number(comments);
        perOwner.set(owner, acc);
      }
      if (!perOwner.size) return;

      // Upsert with += so an owner's images across multiple windows accumulate.
      // Postgres row locks serialize concurrent windows touching the same owner.
      const rows = [...perOwner].map(([user_id, a]) => ({ user_id, ...a }));
      const upsert = await pgDbWrite.cancellableQuery(
        `INSERT INTO ${STAGING} (user_id, reactions, comments)
         SELECT user_id, reactions, comments
         FROM jsonb_to_recordset($1::jsonb) AS x(user_id int, reactions bigint, comments bigint)
         ON CONFLICT (user_id) DO UPDATE SET
           reactions = ${STAGING}.reactions + EXCLUDED.reactions,
           comments = ${STAGING}.comments + EXCLUDED.comments`,
        [JSON.stringify(rows)]
      );
      cancelFns.push(upsert.cancel);
      await upsert.result();

      console.log(`scan: imageId ${start}-${end} → ${engaged.length} engaged, ${perOwner.size} owners`);
    },
  });
}

// Phase 2: write each staged owner's score + total + the backfill marker. Skips
// owners already marked, so it's resumable and never recomputes a finished owner.
async function apply(
  res: NextApiResponse,
  params: z.infer<typeof schema>,
  imageMultipliers: { reactions: number; comments: number; views: number }
) {
  const stampedAt = new Date().toISOString();
  // apply windows by userId, not entityId.
  const applyParams = { ...params, batchSize: Math.min(params.batchSize, 50_000) };

  await dataProcessor({
    params: applyParams,
    runContext: res,
    rangeFetcher: async (ctx) => {
      const [{ max }] = await pgDbRead
        .cancellableQuery<{ max: number }>(`SELECT MAX(user_id) AS max FROM ${STAGING}`)
        .then((q) => q.result());
      return { start: ctx.start, end: max ?? 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      // Staged owners in this userId window that haven't been stamped yet.
      const q = await pgDbRead.cancellableQuery<{ user_id: number; reactions: number; comments: number }>(
        `SELECT s.user_id, s.reactions, s.comments
         FROM ${STAGING} s
         JOIN "User" u ON u.id = s.user_id
         WHERE s.user_id >= $1 AND s.user_id <= $2
           AND (u.meta->'scores'->>'imagesBackfilledAt') IS NULL`,
        [start, end]
      );
      cancelFns.push(q.cancel);
      const owners = await q.result();
      if (!owners.length) return;

      // images score + recomputed total (shared with the cron).
      const records = owners.map(
        ({ user_id, reactions, comments }) =>
          [
            String(user_id),
            {
              images: Number(reactions) * imageMultipliers.reactions + Number(comments) * imageMultipliers.comments,
            },
          ] as [string, { images: number }]
      );
      await applyUserScoreUpdates(pgDbWrite, records, (cancel) => cancelFns.push(cancel));

      // Stamp the marker so a re-run skips these owners.
      const markQuery = await pgDbWrite.cancellableQuery(
        `UPDATE "User"
         SET meta = jsonb_set(COALESCE(meta, '{}'), '{scores,imagesBackfilledAt}', to_jsonb($1::text))
         WHERE id = ANY($2::int[])`,
        [stampedAt, owners.map((o) => o.user_id)]
      );
      cancelFns.push(markQuery.cancel);
      await markQuery.result();

      console.log(`apply: userId ${start}-${end} → ${owners.length} owners written`);
    },
  });
}

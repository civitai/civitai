import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import {
  applyUserScoreUpdates,
  computeImageScores,
  getScoreMultipliers,
} from '~/server/jobs/update-user-score';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * One-off backfill for the creator-score `images` category.
 *
 * The image score was silently 0 for everyone (the cron read the stale
 * `image_metrics_user` table). The fix in `update-user-score` reads
 * `entityMetricDailyAgg_v2`, but it's incremental — it only revisits owners with
 * recent image engagement. This sweep recomputes EVERY image owner's `images`
 * score (and their `total`) so the historically-missing contribution is restored.
 *
 * Idempotent: each owner's score is recomputed from current v2 metrics, so
 * re-running (or re-running a sub-range) is safe.
 *
 * Ranges over `Image."userId"` windows via `dataProcessor`; each window resolves
 * its owners, scores them with the shared `computeImageScores`, and writes via
 * `applyUserScoreUpdates`. Runs to completion in a single request — drive it from
 * the no-timeout dev server (which talks to prod) and keep the client connected
 * (nohup/screen); disconnecting cancels in-flight queries.
 *
 * Auth via the existing `WebhookEndpoint(?token=...)` gate.
 *
 * Usage:
 *   GET /api/admin/temp/backfill-image-scores?token=<WEBHOOK_TOKEN>
 *   optional: &concurrency=3 &batchSize=10000 &start=0 &end=<maxUserId>
 *   start/end target an inclusive userId range — `start=X&end=X` backfills exactly
 *   user X; omit both to sweep everyone; set start=<lastId> to resume.
 */

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(20).optional().default(3),
  // width of the Image."userId" window handled per task (sparse id space, so a
  // window holds far fewer owners than its width).
  batchSize: z.coerce.number().min(1).optional().default(10000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!clickhouse) return res.status(503).json({ error: 'ClickHouse is not available' });

  console.time('BACKFILL_IMAGE_SCORES');
  await backfillImageScores(req, res);
  console.timeEnd('BACKFILL_IMAGE_SCORES');

  res.status(200).json({ finished: true });
});

async function backfillImageScores(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  const scoreMultipliers = await getScoreMultipliers();

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (ctx) => {
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("userId") "max" FROM "Image"`
      );
      return { start: ctx.start, end: max ?? 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      // Distinct owners in this userId window (bounded range → cheap index scan).
      // Inclusive lower bound so `start=X&end=X` targets exactly user X (and so
      // consecutive dataProcessor windows stay contiguous with no skipped id).
      const ownerQuery = await pgDbRead.cancellableQuery<{ id: number }>(
        `SELECT DISTINCT "userId" AS id
         FROM "Image"
         WHERE "userId" >= $1 AND "userId" <= $2 AND "userId" IS NOT NULL`,
        [start, end]
      );
      cancelFns.push(ownerQuery.cancel);
      const owners = (await ownerQuery.result()).map((r) => r.id);
      if (!owners.length) return;

      const scores = await computeImageScores(
        { ch: clickhouse!, pg: pgDbRead, scoreMultipliers, onCancel: (cancel) => cancelFns.push(cancel) },
        owners
      );
      const records = owners.map(
        (uid) => [String(uid), { images: scores.get(uid)?.score ?? 0 }] as [string, { images: number }]
      );
      await applyUserScoreUpdates(pgDbWrite, records, (cancel) => cancelFns.push(cancel));

      console.log(`backfill-image-scores: userId ${start}-${end} → ${owners.length} owners updated`);
    },
  });
}

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { deleteImagesForModelVersionCache } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(1).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  // How far back to look when selecting model versions to refresh.
  sinceDays: z.coerce.number().min(0).max(365).optional().default(14),
  // Optional comma-separated list of model version IDs to bust explicitly.
  // When provided, overrides the sinceDays window.
  ids: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0)
        : undefined
    )
    .refine((ids) => ids === undefined || ids.length > 0, {
      message: 'ids must contain at least one valid positive numeric model version ID',
    }),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('BUST_MV_IMAGES_CACHE_TIMER');
  await bustModelVersionImagesCache(req, res);
  console.timeEnd('BUST_MV_IMAGES_CACHE_TIMER');
  res.status(200).json({ finished: true });
});

async function bustModelVersionImagesCache(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);

  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery<{ id: number }>(
        `
        SELECT mv.id
        FROM "ModelVersion" mv
        WHERE mv."publishedAt" > NOW() - (INTERVAL '1 day' * $1::int)
        ORDER BY mv.id;
      `,
        [params.sinceDays]
      );
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, batchNumber, batchCount }) => {
      if (!batch.length) return;
      await deleteImagesForModelVersionCache(batch);
      console.log(`Busted batch ${batchNumber} of ${batchCount} (${batch.length} model versions)`);
    },
  });
}

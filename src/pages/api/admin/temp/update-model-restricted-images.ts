import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(0).optional().default(1000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('UPDATE_MODEL_RESTRICTED_TIMER');
  await updateModelRestrictedImages(req, res);
  console.timeEnd('UPDATE_MODEL_RESTRICTED_TIMER');
  res.status(200).json({ finished: true });
});

async function updateModelRestrictedImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery<{ id: number }>(`
        SELECT
          "imageId" as id
        FROM "RestrictedImagesByBaseModel"
        ORDER BY "imageId";
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      const query = await pgDbWrite.cancellableQuery(
        `
        UPDATE "Image"
          SET "modelRestricted" = true
        WHERE id = ANY($1::int[])
          AND "modelRestricted" IS DISTINCT FROM true;`,
        [batch]
      );
      cancelFns.push(query.cancel);
      await query.result();
      console.log(`Updated ${batchNumber} of ${batchCount}`);
    },
  });
}

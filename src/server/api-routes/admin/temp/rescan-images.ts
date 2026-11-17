import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(0).optional().default(5000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('MIGRATION_TIMER');
  await rescanImages(req, res);
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function rescanImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery<{ id: number }>(`
        SELECT
          "imageId" as id
        FROM temp_to_rescan
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
        UPDATE "Image" i
          SET "scanRequestedAt" = null, "scannedAt" = null, ingestion = 'Pending'
        WHERE id = ANY($1::int[])
          AND NOT i."nsfwLevelLocked" AND i."nsfwLevel" <= 1;`,
        [batch]
      );
      cancelFns.push(query.cancel);
      await query.result();
      console.log(`Updated ${batchNumber} of ${batchCount}`);

      const deleteQuery = await pgDbWrite.cancellableQuery(
        `
        DELETE FROM "TagsOnImageNew"
        WHERE "imageId" = ANY($1::int[]) AND "tagId" = 256917;`,
        [batch]
      );
      cancelFns.push(deleteQuery.cancel);
      await deleteQuery.result();
      console.log(`Deleted tag ${batchNumber} of ${batchCount}`);
    },
  });
}

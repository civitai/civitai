import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('MIGRATION_TIMER');
  await migrateTagLevels(req, res);
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateTagLevels(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery(`
        SELECT
          "imageId" as id
        FROM temp_to_update
        ORDER BY "imageId";
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      const { cancel, result } = await pgDbWrite.cancellableQuery(`
        UPDATE "Image" i
          SET "nsfwLevel" = (
            SELECT COALESCE(MAX(t."nsfwLevel"), 0)
            FROM "TagsOnImageDetails" toi
            JOIN "Tag" t ON t.id = toi."tagId"
            WHERE toi."imageId" = i.id
              AND toi."disabled" IS FALSE
          )
        WHERE id IN (${batch}) AND i.ingestion = '${ImageIngestionStatus.Scanned}'::"ImageIngestionStatus" AND NOT i."nsfwLevelLocked" AND i."nsfwLevel" = 1;
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated ${batchNumber} of ${batchCount}`);
    },
  });
}

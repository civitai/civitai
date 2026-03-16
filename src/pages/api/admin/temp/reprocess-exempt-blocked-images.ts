import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(1).max(5000).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('REPROCESS_TIMER');
  await reprocessExemptBlockedImages(req, res);
  console.timeEnd('REPROCESS_TIMER');
  res.status(200).json({ finished: true });
});

async function reprocessExemptBlockedImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery<{ id: number }>(`
        WITH exempt_ids AS (
          SELECT u."profilePictureId" AS id FROM "User" u WHERE u."profilePictureId" IS NOT NULL
          UNION
          SELECT up."coverImageId" FROM "UserProfile" up WHERE up."coverImageId" IS NOT NULL
          UNION
          SELECT a."coverId" FROM "Article" a WHERE a."coverId" IS NOT NULL
          UNION
          SELECT ch."coverImageId" FROM "Challenge" ch WHERE ch."coverImageId" IS NOT NULL
          UNION
          SELECT ic."imageId" FROM "ImageConnection" ic WHERE ic."entityType" IN ('Bounty')
        )
        SELECT i.id
        FROM "Image" i
        JOIN exempt_ids e ON e.id = i.id
        WHERE i."blockedFor" = 'AiNotVerified'
        ORDER BY i.id;
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      const updateQuery = await pgDbWrite.cancellableQuery(
        `
        UPDATE "Image"
        SET "ingestion" = 'Rescan', "blockedFor" = NULL
        WHERE id = ANY($1::int[]);
        `,
        [batch]
      );
      cancelFns.push(updateQuery.cancel);
      await updateQuery.result();

      const enqueueQuery = await pgDbWrite.cancellableQuery(
        `
        INSERT INTO "JobQueue" (type, "entityType", "entityId")
        SELECT 'ImageScan'::"JobQueueType", 'Image'::"EntityType", unnest($1::int[])
        ON CONFLICT DO NOTHING;
        `,
        [batch]
      );
      cancelFns.push(enqueueQuery.cancel);
      await enqueueQuery.result();

      console.log(`Batch ${batchNumber} of ${batchCount}: updated ${batch.length} images`);
    },
  });
}

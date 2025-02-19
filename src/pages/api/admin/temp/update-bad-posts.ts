import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { batchProcessor } from '~/server/db/db-helpers';
import { pgDbRead, pgDbWrite } from '~/server/db/pgDb';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(20),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('TIMER');
  await action(req, res);
  console.timeEnd('TIMER');
  res.status(200).json({ finished: true });
});

async function action(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await batchProcessor({
    params,
    runContext: res,
    batchFetcher: async (context) => {
      const query = await pgDbRead.cancellableQuery(`
        SELECT
          id
        FROM temp_fix_posts
        ORDER BY 1;
      `);
      context.cancelFns.push(query.cancel);
      const results = await query.result();
      return results.map((r) => r.id);
    },
    processor: async ({ batch, cancelFns, batchNumber, batchCount }) => {
      if (!batch.length) return;

      const { cancel, result } = await pgDbWrite.cancellableQuery(`
        UPDATE "Post" p SET "publishedAt" = t."publishedAt"
        FROM temp_fix_posts t
        WHERE p.id = t.id AND t.id IN (${batch})
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated ${batchNumber} of ${batchCount}`);

      const images = await dbRead.image.findMany({
        where: { postId: { in: batch } },
        select: { id: true },
      });

      // Update all affected images in search index
      await imagesSearchIndex.queueUpdate(
        images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
      );
      await imagesMetricsSearchIndex.queueUpdate(
        images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
      );
      console.log(`Queued Search Index Update ${batchNumber} of ${batchCount}`);
    },
  });
}

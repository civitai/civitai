import * as z from 'zod';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  dryRun: booleanString().default(true),
  concurrency: z.coerce.number().min(1).max(10).default(5),
  batchSize: z.coerce.number().min(1).default(10000),
  start: z.coerce.number().min(0).default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);

  let totalFound = 0;
  let totalQueued = 0;

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async () => {
      const [result] = await (
        await pgDbRead.cancellableQuery<{ start: number; end: number }>(`
          SELECT MIN(id) as "start", MAX(id) as "end"
          FROM "Image"
          WHERE "postId" IS NULL
        `)
      ).result();
      return result ?? { start: 0, end: 0 };
    },
    processor: async ({ start, end, cancelFns }) => {
      // Find images in this ID range that have postId NULL
      const fetchQuery = await pgDbRead.cancellableQuery<{ id: number }>(
        `
        SELECT id
        FROM "Image"
        WHERE id >= $1 AND id <= $2
          AND "postId" IS NULL
      `,
        [start, end]
      );
      cancelFns.push(fetchQuery.cancel);
      const images = await fetchQuery.result();

      if (!images.length) return;

      totalFound += images.length;

      if (params.dryRun) {
        console.log(`Range ${start}-${end}: found ${images.length} orphaned images`);
        return;
      }

      const ids = images.map((i) => i.id);
      await queueImageSearchIndexUpdate({
        ids,
        action: SearchIndexUpdateQueueAction.Delete,
      });
      totalQueued += ids.length;

      console.log(`Range ${start}-${end}: queued ${ids.length} images for search index deletion`);
    },
  });

  res.status(200).json({
    finished: true,
    dryRun: params.dryRun,
    totalFound,
    totalQueued,
  });
});

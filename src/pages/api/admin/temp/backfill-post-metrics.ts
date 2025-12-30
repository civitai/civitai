import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(0).optional().default(1000),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('BACKFILL_TIMER');
  await backfillPostMetrics(req, res);
  console.timeEnd('BACKFILL_TIMER');
  res.status(200).json({ finished: true });
});

async function backfillPostMetrics(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);

  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      const [{ max }] = await dbWrite.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("id") "max" FROM "Post";`
      );

      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      console.log(`Processing posts ${start} - ${end}`);

      const updateQuery = await pgDbWrite.cancellableQuery(`
        UPDATE "Post" p
        SET
          "reactionCount"  = pm."reactionCount",
          "commentCount"   = pm."commentCount",
          "collectedCount" = pm."collectedCount"
        FROM "PostMetric" pm
        WHERE pm."postId" = p.id
          AND pm.timeframe = 'AllTime'
          AND pm."postId" > ${start} AND pm."postId" <= ${end}
          AND (
            pm."reactionCount" != 0
            OR pm."commentCount" != 0
            OR pm."collectedCount" != 0
          )
      `);

      cancelFns.push(updateQuery.cancel);
      await updateQuery.result();

      console.log(`Updated posts ${start} - ${end}`);
    },
  });
}

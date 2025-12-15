import { Prisma } from '@prisma/client';
import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import { chunk, remove } from 'lodash-es';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(10),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
});

export default WebhookEndpoint(async (req, res) => {
  console.time('MIGRATION_TIMER');
  await migrateImages(req, res);
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

type QueryRes = {
  entityType: EntityMetric_EntityType_Type;
  entityId: number;
  userId: number;
  metricType: EntityMetric_MetricType_Type;
  metricValue: number;
  createdAt: Date;
};

const cutoff = '2024-08-07 15:44:39.044';
const clickBatch = 1000;

const insertClick = async (data: QueryRes[], start: number, end: number) => {
  // console.log({ start, end, data });
  if (data.length) {
    const batches = chunk(data, clickBatch);
    let i = 0;
    for (const batch of batches) {
      try {
        await withRetries(async () => {
          return clickhouse?.insert({
            table: 'entityMetricEvents',
            format: 'JSONEachRow',
            values: batch,
            clickhouse_settings: {
              async_insert: 1,
              wait_for_async_insert: 0,
              date_time_input_format: 'best_effort',
            },
          });
        });
      } catch (e) {
        console.log(`ERROR (batch ${i}) (len: ${batch.length})`, start, '-', end);
        console.log((e as Error).message);
      }
      i += 1;
    }
  }
};

async function migrateImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      // we should always pass start

      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("id") "max" FROM "Image";`
      );

      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      let data: QueryRes[] = [];

      // -- Buzz
      const buzzQuery = await pgDbRead.cancellableQuery<QueryRes>(Prisma.sql`
        SELECT 'Image' as "entityType", "entityId", "fromUserId" as "userId", 'Buzz' as "metricType", amount as "metricValue", "createdAt"
          FROM "BuzzTip"
         WHERE "entityId" BETWEEN ${start} AND ${end}
           AND "createdAt" < ${cutoff}
           AND "entityType" = 'Image'
      `);
      cancelFns.push(buzzQuery.cancel);
      data = data.concat(await buzzQuery.result());
      // ----

      // -- Collection
      const collectionQuery = await pgDbRead.cancellableQuery<QueryRes>(Prisma.sql`
        SELECT 'Image' as "entityType", "imageId" as "entityId", "addedById" as "userId", 'Collection' as "metricType", 1 as "metricValue", "createdAt"
          FROM "CollectionItem"
         WHERE "imageId" BETWEEN ${start} AND ${end}
           AND "createdAt" < ${cutoff}
           AND "imageId" is not null
      `);
      cancelFns.push(collectionQuery.cancel);
      data = data.concat(await collectionQuery.result());
      // ----

      // -- Comment
      const commentQuery = await pgDbRead.cancellableQuery<QueryRes>(Prisma.sql`
        SELECT 'Image' as "entityType", t."imageId" as "entityId", c."userId" as "userId", 'Comment' as "metricType", 1 as "metricValue", c."createdAt" as "createdAt"
          FROM "Thread" t
          JOIN "CommentV2" c ON c."threadId" = t.id
          WHERE t."imageId" BETWEEN ${start} AND ${end}
            AND c."createdAt" < ${cutoff}
            AND t."imageId" IS NOT NULL;
      `);
      cancelFns.push(commentQuery.cancel);
      data = data.concat(await commentQuery.result());
      // ----

      // -- Reaction
      const reactionQuery = await pgDbRead.cancellableQuery<QueryRes>(Prisma.sql`
        SELECT 'Image' as "entityType", "imageId" as "entityId", "userId", concat('Reaction', reaction) as "metricType", 1 as "metricValue", "createdAt"
          FROM "ImageReaction"
         WHERE "imageId" BETWEEN ${start} AND ${end}
           AND "createdAt" < ${cutoff}
           AND reaction in ('Like', 'Laugh', 'Cry', 'Heart')
      `);
      cancelFns.push(reactionQuery.cancel);
      data = data.concat(await reactionQuery.result());
      // ----

      await insertClick(data, start, end);

      console.log(`Fetched metrics:`, start, '-', end);

      remove(cancelFns, (v) =>
        [
          commentQuery.cancel,
          reactionQuery.cancel,
          buzzQuery.cancel,
          collectionQuery.cancel,
        ].includes(v)
      );
    },
  });
}

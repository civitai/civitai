import { EntityMetric_EntityType_Type, EntityMetric_MetricType_Type, Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { pgDbRead } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
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

async function migrateImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  console.log({ params });
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      // we should always pass start

      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX("imageId") "max" FROM "ImageMetric";`
      );

      return { start: context.start, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const imQuery = await pgDbRead.cancellableQuery<{
        imageId: number;
        likeCount: number;
        heartCount: number;
        laughCount: number;
        cryCount: number;
        commentCount: number;
        collectedCount: number;
        tippedAmountCount: number;
      }>(Prisma.sql`
        SELECT "imageId", "likeCount", "heartCount", "laughCount", "cryCount", "commentCount", "collectedCount", "tippedAmountCount"
        FROM "ImageMetric" im WHERE timeframe = 'AllTime' AND im."imageId" BETWEEN ${start} AND ${end}
      `);
      cancelFns.push(imQuery.cancel);
      const imData = await imQuery.result();

      if (!imData.length) {
        console.log(`Fetched metrics: (${imData.length})`, start, '-', end);
        return;
      }

      const emData = imData.flatMap((imd) => {
        const baseData = {
          entityType: EntityMetric_EntityType_Type.Image,
          entityId: imd.imageId,
        };
        return [
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.ReactionLike,
            metricValue: imd.likeCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.ReactionHeart,
            metricValue: imd.heartCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.ReactionLaugh,
            metricValue: imd.laughCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.ReactionCry,
            metricValue: imd.cryCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.Comment,
            metricValue: imd.commentCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.Collection,
            metricValue: imd.collectedCount,
          },
          {
            ...baseData,
            metricType: EntityMetric_MetricType_Type.Buzz,
            metricValue: imd.tippedAmountCount,
          },
        ];
      });

      // console.log(emData);

      try {
        await dbWrite.entityMetric.createMany({
          data: emData,
          skipDuplicates: true,
        });
      } catch (e) {
        console.log(`ERROR PG: (${imData.length})`, start, '-', end);
        console.log((e as Error).message);
      }

      try {
        await clickhouse?.insert({
          table: 'entityMetricEvents',
          format: 'JSONEachRow',
          values: emData.map((emd) => ({ ...emd, userId: -1, createdAt: new Date() })),
          clickhouse_settings: {
            async_insert: 1,
            wait_for_async_insert: 0,
            date_time_input_format: 'best_effort',
          },
        });
      } catch (e) {
        console.log(`ERROR CLICK: (${imData.length})`, start, '-', end);
        console.log((e as Error).message);
      }

      console.log(`Fetched metrics: (${imData.length})`, start, '-', end);
    },
  });
}

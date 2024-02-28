import { Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency, Task } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  cursor: z.coerce.number().optional().default(0),
  batchSize: z.coerce.number().optional().default(100),
});

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  let { cursor } = params;
  const { batchSize } = params;
  const maxCursorQuery = await pgDbWrite.cancellableQuery<{ maxCursor: number }>(`
    SELECT MAX("id") as "maxCursor"
    FROM "Model"
    WHERE status = 'Published';
  `);
  res.on('close', maxCursorQuery.cancel);
  const [{ maxCursor }] = await maxCursorQuery.result();
  console.log('Migrating model metrics:', maxCursor);

  let stop = false;
  const cancelFns: (() => void)[] = [];
  res.on('close', () => {
    stop = true;
    cancelFns.forEach((fn) => fn());
  });

  const tasks: Task[] = [];
  while (cursor <= maxCursor) {
    const start = cursor;
    cursor += batchSize;
    const end = Math.min(cursor, maxCursor);

    // Migrate version collections metrics
    // We don't use version collection metrics...
    // tasks.push(async () => {
    //   if (stop) return;
    //   console.log('Migrate version collection metrics ' + start + '-' + end);
    //   console.time('Migrate version collection metrics ' + start + '-' + end);
    //   const migrateCollectionsQuery = await pgDbWrite.cancellableQuery(`
    //     -- Migrate model collections metrics
    //     INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "collectedCount")
    //     SELECT
    //       mv."id",
    //       tf.timeframe,
    //       COALESCE(SUM(
    //         CASE
    //           WHEN tf.timeframe = 'AllTime' THEN 1
    //           WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
    //           WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
    //           WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
    //           WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
    //         END
    //       ), 0)
    //     FROM (
    //       SELECT
    //         "modelId",
    //         "addedById",
    //         MAX(c."createdAt") "createdAt"
    //       FROM "CollectionItem" c
    //       JOIN "Model" m ON m.id = c."modelId"
    //       WHERE "modelId" IS NOT NULL
    //         AND m."userId" != c."addedById"
    //         AND "modelId" BETWEEN ${start} AND ${end}
    //       GROUP BY "modelId", "addedById"
    //     ) i
    //     JOIN "ModelVersion" mv ON mv."modelId" = i."modelId"
    //     CROSS JOIN (
    //       SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    //     ) tf
    //     GROUP BY mv."id", tf.timeframe
    //     ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = now();
    //   `);
    //   cancelFns.push(migrateCollectionsQuery.cancel);
    //   await migrateCollectionsQuery.result();
    //   console.timeEnd('Migrate version collection metrics ' + start + '-' + end);
    // });

    // Migrate version thumbs up metrics
    tasks.push(async () => {
      if (stop) return;
      console.log('Migrate version thumbs up metrics ' + start + '-' + end);
      console.time('Migrate version thumbs up metrics ' + start + '-' + end);
      const migrateThumbsUpQuery = await pgDbWrite.cancellableQuery(Prisma.sql`
        -- Migrate model version thumbs up metrics
        INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "thumbsUpCount", "thumbsDownCount")
        SELECT
          r."modelVersionId",
          tf.timeframe,
          COUNT(DISTINCT CASE
            WHEN NOT recommended THEN NULL
            WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
            WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
            WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
            WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          END) "thumbsUpCount",
          COUNT(DISTINCT CASE
            WHEN recommended THEN NULL
            WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
            WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
            WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
            WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          END) "thumbsDownCount"
        FROM "ResourceReview" r
        CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
        WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelId" BETWEEN ${start} AND ${end}
        GROUP BY r."modelVersionId", tf.timeframe
        ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
      `);
      cancelFns.push(migrateThumbsUpQuery.cancel);
      await migrateThumbsUpQuery.result();
      console.timeEnd('Migrate version thumbs up metrics ' + start + '-' + end);
    });

    // Migrate model thumbs up metrics
    tasks.push(async () => {
      if (stop) return;
      console.log('Migrate model thumbs up metrics ' + start + '-' + end);
      console.time('Migrate model thumbs up metrics ' + start + '-' + end);
      const updateModelThumbsUpQuery = await pgDbWrite.cancellableQuery(Prisma.sql`
        -- Migrate model thumbs up metrics
        INSERT INTO "ModelMetric" ("modelId", timeframe, "thumbsUpCount", "thumbsDownCount")
        SELECT
          r."modelId",
          tf.timeframe,
          COUNT(DISTINCT CASE
            WHEN NOT recommended THEN NULL
            WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
            WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
            WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
            WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          END) "thumbsUpCount",
          COUNT(DISTINCT CASE
            WHEN recommended THEN NULL
            WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
            WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
            WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
            WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          END) "thumbsDownCount"
        FROM "ResourceReview" r
        CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
        WHERE r.exclude = FALSE
        AND r."tosViolation" = FALSE
        AND r."modelId" BETWEEN ${start} AND ${end}
        GROUP BY r."modelId", tf.timeframe
        ON CONFLICT ("modelId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
      `);
      cancelFns.push(updateModelThumbsUpQuery.cancel);
      await updateModelThumbsUpQuery.result();
      console.timeEnd('Migrate model thumbs up metrics ' + start + '-' + end);
    });

    // Migrate model collects
    tasks.push(async () => {
      if (stop) return;
      console.log('Migrate model collects ' + start + '-' + end);
      console.time('Migrate model collects ' + start + '-' + end);
      const updateModelMetricsQuery = await pgDbWrite.cancellableQuery(Prisma.sql`
        -- Migrate model collection metrics
        INSERT INTO "ModelMetric" ("modelId", timeframe, "collectedCount")
        SELECT
          "modelId",
          timeframe,
          COUNT(DISTINCT CASE
            WHEN timeframe = 'AllTime' THEN c."addedById"
            WHEN timeframe = 'Year' AND c."createdAt" > NOW() - interval '1 year' THEN c."addedById"
            WHEN timeframe = 'Month' AND c."createdAt" > NOW() - interval '1 month' THEN c."addedById"
            WHEN timeframe = 'Week' AND c."createdAt" > NOW() - interval '1 week' THEN c."addedById"
            WHEN timeframe = 'Day' AND c."createdAt" > NOW() - interval '1 day' THEN c."addedById"
          END) as "collectedCount"
        FROM "CollectionItem" c
        CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
        WHERE c."modelId" BETWEEN ${start} AND ${end}
        GROUP BY "modelId", timeframe
        ON CONFLICT ("modelId", timeframe) DO UPDATE SET
          "collectedCount" = EXCLUDED."collectedCount",
          "updatedAt" = EXCLUDED."updatedAt";
      `);
      cancelFns.push(updateModelMetricsQuery.cancel);
      await updateModelMetricsQuery.result();
      console.timeEnd('Migrate model collects ' + start + '-' + end);
    });
  }

  await limitConcurrency(tasks, 50);

  return res.status(200).json({
    ok: true,
  });
});

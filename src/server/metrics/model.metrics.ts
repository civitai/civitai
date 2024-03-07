import dayjs from 'dayjs';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { modelsSearchIndex } from '~/server/search-index';
import { Prisma, PrismaClient, SearchIndexUpdateQueueAction } from '@prisma/client';
import { chunk } from 'lodash-es';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctx) {
    // If this is the first metric update of the day, recompute all recently affected metrics
    // -------------------------------------------------------------------
    const shouldFullRefresh = ctx.lastUpdate.getDate() !== new Date().getDate();
    if (shouldFullRefresh) ctx.lastUpdate = dayjs(ctx.lastUpdate).subtract(1.5, 'day').toDate();

    const updatedModelIds = new Set<number>();

    for (const processor of modelMetricProcessors) {
      ctx.jobContext.checkIfCanceled();
      const processorUpdatedModelIds = await processor(ctx);
      processorUpdatedModelIds.forEach((id) => updatedModelIds.add(id));
    }

    if (updatedModelIds.size > 0) {
      await modelsSearchIndex.queueUpdate(
        [...updatedModelIds].map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }
  },
  rank: {
    async refresh(ctx) {
      // Do nothing. Rank views are now not used.
    },
    refreshInterval: 60 * 1000,
  },
});

// #region [metrics]
const modelMetricProcessors = [
  updateVersionDownloadMetrics,
  updateVersionGenerationMetrics,
  updateVersionRatingMetrics,
  updateModelRatingMetrics,
  updateVersionCommentMetrics,
  updateCollectMetrics,
  updateTippedBuzzMetrics,
  // updateVersionImageMetrics,
  updateModelMetrics,
];

async function getModelIdFromVersions({
  versionIds,
  db,
}: {
  versionIds: Array<number>;
  db: PrismaClient;
}) {
  const affectedModelIds: Set<number> = new Set();
  const batches = chunk(versionIds, 500);
  for (const batch of batches) {
    const batchAffectedModels: Array<{ modelId: number }> =
      await db.$queryRaw`SELECT "modelId" FROM "ModelVersion" WHERE "id" IN (${Prisma.join(
        batch
      )});`;

    for (const { modelId } of batchAffectedModels) affectedModelIds.add(modelId);
  }

  return [...affectedModelIds];
}

async function updateVersionDownloadMetrics({
  ch,
  db,
  jobContext,
  lastUpdate,
}: MetricProcessorRunContext) {
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const affectedVersionIdsResponse = await ch.query({
    query: `
      SELECT DISTINCT modelVersionId
      FROM modelVersionEvents
      WHERE type = 'Download'
      AND time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
    `,
    format: 'JSONEachRow',
  });
  const versionIds = (
    (await affectedVersionIdsResponse?.json()) as [
      {
        modelVersionId: number;
      }
    ]
  ).map((x) => x.modelVersionId);

  const batches = chunk(versionIds, 5000);
  let rows = 0;
  for (const batch of batches) {
    try {
      const affectedModelVersionsResponse = await ch.query({
        query: `
          SELECT
            modelVersionId,
            uniqMergeIf(users_state, createdDate = current_date()) day,
            uniqMergeIf(users_state, createdDate >= subtractDays(current_date(),7)) week,
            uniqMergeIf(users_state, createdDate >= subtractMonths(current_date(),1)) month,
            uniqMergeIf(users_state, createdDate >= subtractYears(current_date(),1)) year,
            uniqMerge(users_state) all_time
          FROM daily_downloads_unique
          WHERE modelVersionId IN (${batch.join(',')})
          GROUP BY 1
        `,
        format: 'JSONEachRow',
      });

      const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
        {
          modelVersionId: number;
          day: string;
          week: string;
          month: string;
          year: string;
          all_time: string;
        }
      ];

      // We batch the affected model versions up when sending it to the db
      const batches = chunk(affectedModelVersions, 1000);
      for (const batch of batches) {
        jobContext.checkIfCanceled();
        const batchJson = JSON.stringify(batch);

        rows += await db.$executeRaw`
          -- update version download metrics
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount")
          SELECT
              mvm.modelVersionId, mvm.timeframe, mvm.downloads
          FROM
          (
              SELECT
                  CAST(mvs::json->>'modelVersionId' AS INT) AS modelVersionId,
                  tf.timeframe,
                  CAST(
                    CASE
                      WHEN tf.timeframe = 'Day' THEN mvs::json->>'day'
                      WHEN tf.timeframe = 'Week' THEN mvs::json->>'week'
                      WHEN tf.timeframe = 'Month' THEN mvs::json->>'month'
                      WHEN tf.timeframe = 'Year' THEN mvs::json->>'year'
                      WHEN tf.timeframe = 'AllTime' THEN mvs::json->>'all_time'
                    END
                  AS int) as downloads
              FROM json_array_elements(${batchJson}::json) mvs
              CROSS JOIN (
                  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
              ) tf
          ) mvm
          WHERE mvm.downloads IS NOT NULL
          AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion")
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
            SET "downloadCount" = EXCLUDED."downloadCount", "updatedAt" = now();
        `;
      }
    } catch (e) {
      throw e;
    }
  }
  console.log('downloads', rows);

  if (versionIds.length > 0) {
    // Get affected models from version IDs:
    return getModelIdFromVersions({ versionIds, db });
  }

  return [];
}

async function updateVersionGenerationMetrics({
  ch,
  db,
  lastUpdate,
  jobContext,
}: MetricProcessorRunContext) {
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const affectedVersionIdsResponse = await ch.query({
    query: `
      SELECT DISTINCT modelVersionId
      FROM  (
        SELECT
          arrayJoin(resourcesUsed) as modelVersionId
        FROM orchestration.textToImageJobs
        WHERE createdAt >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
      )
    `,
    format: 'JSONEachRow',
  });
  const versionIds = (
    (await affectedVersionIdsResponse?.json()) as [
      {
        modelVersionId: number;
      }
    ]
  ).map((x) => x.modelVersionId);

  const batches = chunk(versionIds, 5000);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();
    try {
      const affectedModelVersionsResponse = await ch.query({
        query: `
          SELECT
              modelVersionId,
              sumIf(count, createdDate = current_date()) day,
              sumIf(count, createdDate >= subtractDays(current_date(), 7)) week,
              sumIf(count, createdDate >= subtractMonths(current_date(), 1)) month,
              sumIf(count, createdDate >= subtractYears(current_date(), 1)) year,
              sum(count) all_time
          FROM daily_resource_generation_counts
          WHERE modelVersionId IN (${batch.join(',')})
          GROUP BY modelVersionId
        `,
        format: 'JSONEachRow',
      });

      const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
        {
          modelVersionId: number;
          day: string;
          week: string;
          month: string;
          year: string;
          all_time: string;
        }
      ];

      // We batch the affected model versions up when sending it to the db
      const batches = chunk(affectedModelVersions, 1000);
      for (const batch of batches) {
        const batchJson = JSON.stringify(batch);

        rows += await db.$executeRaw`
          -- update version generation metrics
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "generationCount")
          SELECT
              mvm.modelVersionId, mvm.timeframe, mvm.generations
          FROM
          (
              SELECT
                  CAST(mvs::json->>'modelVersionId' AS INT) AS modelVersionId,
                  tf.timeframe,
                  CAST(
                    CASE
                      WHEN tf.timeframe = 'Day' THEN mvs::json->>'day'
                      WHEN tf.timeframe = 'Week' THEN mvs::json->>'week'
                      WHEN tf.timeframe = 'Month' THEN mvs::json->>'month'
                      WHEN tf.timeframe = 'Year' THEN mvs::json->>'year'
                      WHEN tf.timeframe = 'AllTime' THEN mvs::json->>'all_time'
                    END
                  AS int) as generations
              FROM json_array_elements(${batchJson}::json) mvs
              CROSS JOIN (
                  SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
              ) tf
          ) mvm
          WHERE mvm.generations IS NOT NULL
          AND mvm.modelVersionId IN (SELECT id FROM "ModelVersion")
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
            SET "generationCount" = EXCLUDED."generationCount", "updatedAt" = now();
        `;
      }
    } catch (e) {
      throw e;
    }
  }
  console.log('generations', rows);

  if (versionIds.length > 0) {
    // Get affected models from version IDs:
    return getModelIdFromVersions({ versionIds, db });
  }

  return [];
}

async function updateVersionRatingMetrics({
  ch,
  db,
  lastUpdate,
  jobContext,
}: MetricProcessorRunContext) {
  // Disabled clickhouse as it seems to be missing resource reviews somehow...
  // const clickhouseSince = dayjs(lastUpdate).toISOString();
  // const affectedModelVersionsResponse = await ch.query({
  //   query: `
  //     SELECT DISTINCT modelVersionId
  //     FROM resourceReviews
  //     WHERE time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
  //   `,
  //   format: 'JSONEachRow',
  // });
  // const affectedModelVersionsClickhouse = (await affectedModelVersionsResponse?.json()) as [
  //   {
  //     modelVersionId: number;
  //   }
  // ];
  const modelVersionIds = new Set<number>();

  const affectedModelVersionsDb = await db.$queryRaw<{ modelVersionId: number }[]>`
    SELECT DISTINCT "modelVersionId"
    FROM "ResourceReview"
    WHERE "createdAt" > ${lastUpdate} OR "updatedAt" > ${lastUpdate}
  `;
  affectedModelVersionsDb.forEach(({ modelVersionId }) => modelVersionIds.add(modelVersionId));

  const batches = chunk([...modelVersionIds], 500);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();
    rows += await db.$executeRaw`
      -- update version rating metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "thumbsUpCount", "thumbsDownCount")
      SELECT
        r."modelVersionId",
        tf.timeframe,
        COUNT(DISTINCT CASE
          WHEN NOT recommended THEN NULL
          WHEN timeframe = 'AllTime' THEN r."userId"
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
        END) "thumbsUpCount",
        COUNT(DISTINCT CASE
          WHEN recommended THEN NULL
          WHEN timeframe = 'AllTime' THEN r."userId"
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
        END) "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
      AND r."tosViolation" = FALSE
      AND r."modelVersionId" IN (${Prisma.join(batch)})
      GROUP BY r."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "thumbsUpCount" = EXCLUDED."thumbsUpCount", "thumbsDownCount" = EXCLUDED."thumbsDownCount", "updatedAt" = now();
    `;
  }
  console.log('ratings', rows);

  if (modelVersionIds.size > 0) {
    // Get affected models from version IDs:
    return getModelIdFromVersions({ versionIds: [...modelVersionIds], db });
  }

  return [];
}

async function updateModelRatingMetrics({ db, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const modelIdSet = new Set<number>();

  const affectedModelVersionsDb = await db.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT "modelId"
    FROM "ResourceReview"
    WHERE "createdAt" > ${lastUpdate} OR "updatedAt" > ${lastUpdate}
  `;
  affectedModelVersionsDb.forEach(({ modelId }) => modelIdSet.add(modelId));

  let rows = 0;
  const modelIds = [...modelIdSet];
  const tasks = chunk(modelIds, 500).map((batch) => async () => {
    jobContext.checkIfCanceled();
    rows += await db.$executeRaw`
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
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsUpCount",
        COUNT(DISTINCT CASE
          WHEN recommended THEN NULL
          WHEN timeframe = 'Year' AND r."createdAt" > NOW() - interval '1 year' THEN r."userId"
          WHEN timeframe = 'Month' AND r."createdAt" > NOW() - interval '1 month' THEN r."userId"
          WHEN timeframe = 'Week' AND r."createdAt" > NOW() - interval '1 week' THEN r."userId"
          WHEN timeframe = 'Day' AND r."createdAt" > NOW() - interval '1 day' THEN r."userId"
          WHEN timeframe = 'AllTime' THEN r."userId"
        END) "thumbsDownCount"
      FROM "ResourceReview" r
      CROSS JOIN ( SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe ) tf
      WHERE r.exclude = FALSE
      AND r."tosViolation" = FALSE
      AND r."modelId" IN (${Prisma.join(batch)})
      GROUP BY r."modelId", tf.timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE SET
        "thumbsUpCount" = EXCLUDED."thumbsUpCount",
        "thumbsDownCount" = EXCLUDED."thumbsDownCount",
        "updatedAt" = now();
    `;
  });

  await limitConcurrency(tasks, 3);
  console.log('model ratings', rows);

  return modelIds;
}

async function updateVersionCommentMetrics({
  ch,
  db,
  lastUpdate,
  jobContext,
}: MetricProcessorRunContext) {
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const affectedModelsResponse = await ch.query({
    query: `
      SELECT DISTINCT entityId AS modelId
      FROM comments
      WHERE time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
      AND type = 'Model'
    `,
    format: 'JSONEachRow',
  });

  const affectedModels = (await affectedModelsResponse?.json()) as [
    {
      modelId: number;
    }
  ];

  const modelIds = affectedModels.map((x) => x.modelId);
  const batches = chunk(modelIds, 500);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();
    const batchJson = JSON.stringify(batch);

    rows += await db.$executeRaw`
      -- update version comment metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "commentCount")
      SELECT
          mv."id",
          tf.timeframe,
          COALESCE(SUM(
              CASE
                  WHEN tf.timeframe = 'AllTime' THEN 1
                  WHEN tf.timeframe = 'Year' THEN IIF(c."createdAt" >= NOW() - interval '1 year', 1, 0)
                  WHEN tf.timeframe = 'Month' THEN IIF(c."createdAt" >= NOW() - interval '1 month', 1, 0)
                  WHEN tf.timeframe = 'Week' THEN IIF(c."createdAt" >= NOW() - interval '1 week', 1, 0)
                  WHEN tf.timeframe = 'Day' THEN IIF(c."createdAt" >= NOW() - interval '1 day', 1, 0)
              END
          ), 0)
      FROM (
          SELECT
              c."modelId",
              c."createdAt"
          FROM "Comment" c
          WHERE c."tosViolation" = false
          AND c."modelId" = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
      ) c
      JOIN "ModelVersion" mv ON c."modelId" = mv."modelId"
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      GROUP BY mv.id, tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "commentCount" = EXCLUDED."commentCount", "updatedAt" = now();
    `;
  }
  console.log('comments', rows);

  return modelIds;
}

async function updateVersionImageMetrics({
  db,
  lastUpdate,
  jobContext,
}: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelVersionId: number }[]>`
    SELECT DISTINCT
      ir."modelVersionId"
    FROM "Image" i
    JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
    JOIN "Post" p ON i."postId" = p.id
    WHERE p."publishedAt" < now() AND p."publishedAt" > ${lastUpdate};
  `;

  const versionIds = affected.map((x) => x.modelVersionId);

  const batches = chunk(versionIds, 500);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();
    rows += await db.$executeRaw`
      -- update version image metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "imageCount")
      SELECT
          i."modelVersionId",
          tf.timeframe,
          COALESCE(SUM(
            CASE
              WHEN tf.timeframe = 'AllTime' THEN 1
              WHEN tf.timeframe = 'Year' THEN IIF(i."publishedAt" >= NOW() - interval '1 year', 1, 0)
              WHEN tf.timeframe = 'Month' THEN IIF(i."publishedAt" >= NOW() - interval '1 month', 1, 0)
              WHEN tf.timeframe = 'Week' THEN IIF(i."publishedAt" >= NOW() - interval '1 week', 1, 0)
              WHEN tf.timeframe = 'Day' THEN IIF(i."publishedAt" >= NOW() - interval '1 day', 1, 0)
            END
          ), 0)
      FROM (
        SELECT
          ir."modelVersionId",
          p."publishedAt"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        JOIN "ImageResource" ir ON mv.id = ir."modelVersionId"
        JOIN "Image" i ON i.id = ir."imageId" AND m."userId" != i."userId"
        JOIN "Post" p ON i."postId" = p.id AND p."publishedAt" IS NOT NULL AND p."publishedAt" < now()
        WHERE
          mv.id IN (${Prisma.join(batch)}
      ) i
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      GROUP BY i."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "imageCount" = EXCLUDED."imageCount", "updatedAt" = now();
    `;
  }
  console.log('images', rows);

  return getModelIdFromVersions({ versionIds, db });
}

async function updateCollectMetrics({ db, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT
      "modelId"
    FROM "CollectionItem"
    WHERE "modelId" IS NOT NULL AND "createdAt" > ${lastUpdate};
  `;

  const modelIds = affected.map((x) => x.modelId);
  console.log('collects', modelIds.length);

  const batches = chunk(modelIds, 500);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();

    rows += await db.$executeRaw`
      -- update model collect metrics
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
      WHERE c."modelId" IN (${Prisma.join(batch)})
      GROUP BY "modelId", timeframe
      ON CONFLICT ("modelId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount", "updatedAt" = now();
    `;
  }
  console.log('collects', rows);

  return modelIds;
}

async function updateTippedBuzzMetrics({ db, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelId: number }[]>`
    SELECT bt."entityId" as "modelId"
    FROM "BuzzTip" bt
    WHERE bt."entityId" IS NOT NULL AND bt."entityType" = 'Model'
      AND (bt."createdAt" > ${lastUpdate} OR bt."updatedAt" > ${lastUpdate})
  `;

  const modelIds = affected.map((x) => x.modelId);
  console.log('tipped', modelIds.length);

  const batches = chunk(modelIds, 1000);
  let rows = 0;
  for (const batch of batches) {
    jobContext.checkIfCanceled();
    const batchJson = JSON.stringify(batch);

    rows += await db.$executeRaw`
      -- update version buzz metrics
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "tippedCount", "tippedAmountCount")
      SELECT
        mv."id",
        tf.timeframe,
        COALESCE(SUM(
          CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."updatedAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."updatedAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."updatedAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."updatedAt" >= NOW() - interval '1 day', 1, 0)
          END
        ), 0),
        COALESCE(SUM(
          CASE
            WHEN tf.timeframe = 'AllTime' THEN i."amount"
            WHEN tf.timeframe = 'Year' THEN IIF(i."updatedAt" >= NOW() - interval '1 year', i."amount", 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."updatedAt" >= NOW() - interval '1 month', i."amount", 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."updatedAt" >= NOW() - interval '1 week', i."amount", 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."updatedAt" >= NOW() - interval '1 day', i."amount", 0)
          END
        ), 0)
      FROM (
        SELECT
          "entityId" as "modelId",
          bt."updatedAt",
          bt."amount"
        FROM "BuzzTip" bt
        JOIN "Model" m ON m.id = bt."entityId"
        WHERE bt."entityType" = 'Model' AND bt."entityId" IS NOT NULL
            AND bt."entityId" = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
       ) i
      JOIN "ModelVersion" mv ON mv."modelId" = i."modelId"
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      GROUP BY mv."id", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount", "updatedAt" = now();
    `;
  }
  console.log('tipped', rows);

  return modelIds;
}

async function updateModelMetrics({ pg, lastUpdate, jobContext }: MetricProcessorRunContext) {
  const rowsQuery = await pg.cancellableQuery(Prisma.sql`
    INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", "commentCount", "imageCount", "tippedCount", "tippedAmountCount", "generationCount", "updatedAt")
    WITH affected AS (
      SELECT DISTINCT mv."modelId"
      FROM "ModelVersionMetric" mvm
      JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
      WHERE mvm."updatedAt" > ${lastUpdate}
    )
    SELECT
      mv."modelId",
      mvm.timeframe,
      SUM(mvm."downloadCount") "downloadCount",
      MAX(mvm."commentCount") "commentCount",
      SUM(mvm."imageCount") "imageCount",
      MAX(mvm."tippedCount") "tippedCount",
      MAX(mvm."tippedAmountCount") "tippedAmountCount",
      SUM(mvm."generationCount") "generationCount",
      NOW() "updatedAt"
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
    WHERE mv."modelId" IN (SELECT "modelId" FROM affected)
    GROUP BY mv."modelId", mvm.timeframe
    ON CONFLICT ("modelId", timeframe) DO UPDATE SET
      "downloadCount" = EXCLUDED."downloadCount",
      "commentCount" = EXCLUDED."commentCount",
      "imageCount" = EXCLUDED."imageCount",
      "tippedCount" = EXCLUDED."tippedCount",
      "tippedAmountCount" = EXCLUDED."tippedAmountCount",
      "generationCount" = EXCLUDED."generationCount",
      "updatedAt" = EXCLUDED."updatedAt";
  `);
  jobContext.on('cancel', rowsQuery.cancel);
  const affectedModelsRows = await rowsQuery.result();
  console.log('models', affectedModelsRows[0]);

  return [];
}
// #endregion

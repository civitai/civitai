import dayjs from 'dayjs';
import { createMetricProcessor, MetricProcessorRunContext } from '~/server/metrics/base.metrics';
import { modelsSearchIndex } from '~/server/search-index';
import { Prisma, PrismaClient, SearchIndexUpdateQueueAction } from '@prisma/client';
import { chunk } from 'lodash-es';

export const modelMetrics = createMetricProcessor({
  name: 'Model',
  async update(ctx) {
    // If this is the first metric update of the day, recompute all recently affected metrics
    // -------------------------------------------------------------------
    const shouldFullRefresh = ctx.lastUpdate.getDate() !== new Date().getDate();
    if (shouldFullRefresh) ctx.lastUpdate = dayjs(ctx.lastUpdate).subtract(1.5, 'day').toDate();

    const updatedModelIds = new Set<number>();

    for (const processor of modelMetricProcessors) {
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
      await refreshModelVersionRank(ctx);
      await refreshModelRank(ctx);
    },
    refreshInterval: 60 * 1000,
  },
});

// #region [metrics]
const modelMetricProcessors = [
  updateVersionDownloadMetrics,
  updateVersionRatingMetrics,
  updateVersionFavoriteMetrics,
  updateVersionCommentMetrics,
  updateVersionImageMetrics,
  updateCollectMetrics,
  updateTippedBuzzMetrics,
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

async function updateVersionDownloadMetrics({ ch, db, lastUpdate }: MetricProcessorRunContext) {
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
  for (const batch of batches) {
    try {
      const affectedModelVersionsResponse = await ch.query({
        query: `
          SELECT
              mve.modelVersionId AS modelVersionId,
              SUM(if(mve.time >= subtractDays(now(), 1), 1, null)) AS downloads24Hours,
              SUM(if(mve.time >= subtractDays(now(), 7), 1, null)) AS downloads1Week,
              SUM(if(mve.time >= subtractMonths(now(), 1), 1, null)) AS downloads1Month,
              SUM(if(mve.time >= subtractYears(now(), 1), 1, null)) AS downloads1Year,
              COUNT() AS downloadsAll
          FROM modelVersionUniqueDownloads mve
          WHERE mve.modelVersionId IN (${batch.join(',')})
          GROUP BY mve.modelVersionId
        `,
        format: 'JSONEachRow',
      });

      const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
        {
          modelVersionId: number;
          downloads24Hours: string;
          downloads1Week: string;
          downloads1Month: string;
          downloads1Year: string;
          downloadsAll: string;
        }
      ];

      // We batch the affected model versions up when sending it to the db
      const batches = chunk(affectedModelVersions, 1000);
      for (const batch of batches) {
        const batchJson = JSON.stringify(batch);

        await db.$executeRaw`
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
                      WHEN tf.timeframe = 'Day' THEN mvs::json->>'downloads24Hours'
                      WHEN tf.timeframe = 'Week' THEN mvs::json->>'downloads1Week'
                      WHEN tf.timeframe = 'Month' THEN mvs::json->>'downloads1Month'
                      WHEN tf.timeframe = 'Year' THEN mvs::json->>'downloads1Year'
                      WHEN tf.timeframe = 'AllTime' THEN mvs::json->>'downloadsAll'
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
            SET "downloadCount" = EXCLUDED."downloadCount";
        `;
      }
    } catch (e) {
      throw e;
    }
  }

  if (versionIds.length > 0) {
    // Get affected models from version IDs:
    return getModelIdFromVersions({ versionIds, db });
  }

  return [];
}

async function updateVersionRatingMetrics({ ch, db, lastUpdate }: MetricProcessorRunContext) {
  // Disabled clickhouse as it seems to be missing resource reviews somehow...
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const affectedModelVersionsResponse = await ch.query({
    query: `
      SELECT DISTINCT modelVersionId
      FROM resourceReviews
      WHERE time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
    `,
    format: 'JSONEachRow',
  });

  const affectedModelVersionsClickhouse = (await affectedModelVersionsResponse?.json()) as [
    {
      modelVersionId: number;
    }
  ];
  const modelVersionIds = new Set(affectedModelVersionsClickhouse.map((x) => x.modelVersionId));

  const affectedModelVersionsDb = await db.$queryRaw<{ modelVersionId: number }[]>`
    SELECT DISTINCT "modelVersionId"
    FROM "ResourceReview"
    WHERE "createdAt" > ${lastUpdate} OR "updatedAt" > ${lastUpdate}
  `;
  affectedModelVersionsDb.forEach(({ modelVersionId }) => modelVersionIds.add(modelVersionId));

  const batches = chunk([...modelVersionIds], 500);
  for (const batch of batches) {
    const batchJson = JSON.stringify(batch);
    await db.$executeRaw`
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "ratingCount", rating)
      SELECT
          mv.id,
          tf.timeframe,
          COALESCE(SUM(
              CASE
                  WHEN rr."userId" IS NULL THEN 0
                  WHEN tf.timeframe = 'AllTime' THEN 1
                  WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', 1, 0)
                  WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', 1, 0)
                  WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', 1, 0)
                  WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', 1, 0)
              END
          ), 0),
          COALESCE(AVG(
              CASE
                  WHEN rr."userId" IS NULL THEN 0
                  WHEN tf.timeframe = 'AllTime' THEN rating
                  WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= NOW() - interval '1 year', rating, NULL)
                  WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= NOW() - interval '1 month', rating, NULL)
                  WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= NOW() - interval '1 week', rating, NULL)
                  WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= NOW() - interval '1 day', rating, NULL)
              END
          ), 0)
      FROM "ModelVersion" mv
      LEFT JOIN (
          SELECT
              r."userId",
              r."modelVersionId",
              MAX(r.rating) rating,
              MAX(r."createdAt") AS created_at
          FROM "ResourceReview" r
          JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
          WHERE r.exclude = FALSE
          AND r."tosViolation" = FALSE
          AND r."modelVersionId" = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
          GROUP BY r."userId", r."modelVersionId"
      ) rr ON rr."modelVersionId" = mv.id
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      WHERE mv.id = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
      GROUP BY mv.id, tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating;
    `;
  }

  if (modelVersionIds.size > 0) {
    // Get affected models from version IDs:
    return getModelIdFromVersions({ versionIds: [...modelVersionIds], db });
  }

  return [];
}

async function updateVersionFavoriteMetrics({ ch, db, lastUpdate }: MetricProcessorRunContext) {
  const clickhouseSince = dayjs(lastUpdate).toISOString();
  const affectedModelsResponse = await ch.query({
    query: `
      SELECT DISTINCT modelId
      FROM modelEngagements
      WHERE time >= parseDateTimeBestEffortOrNull('${clickhouseSince}')
      AND type = 'Favorite' OR type = 'Delete'
    `,
    format: 'JSONEachRow',
  });

  const affectedModels = (await affectedModelsResponse?.json()) as [
    {
      modelId: number;
    }
  ];

  const affectedModelsJson = JSON.stringify(affectedModels.map((x) => x.modelId));

  const sqlAnd = [Prisma.sql`f.type = 'Favorite'`];
  // Conditionally pass the affected models to the query if there are less than 1000 of them
  if (affectedModels.length < 1000)
    sqlAnd.push(
      Prisma.sql`f."modelId" = ANY (SELECT json_array_elements(${affectedModelsJson}::json)::text::integer)`
    );

  await db.$executeRaw`
    INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "favoriteCount")
    SELECT
        mv."id",
        tf.timeframe,
        COALESCE(SUM(
            CASE
                WHEN tf.timeframe = 'AllTime' THEN 1
                WHEN tf.timeframe = 'Year' THEN IIF(f."createdAt" >= NOW() - interval '1 year', 1, 0)
                WHEN tf.timeframe = 'Month' THEN IIF(f."createdAt" >= NOW() - interval '1 month', 1, 0)
                WHEN tf.timeframe = 'Week' THEN IIF(f."createdAt" >= NOW() - interval '1 week', 1, 0)
                WHEN tf.timeframe = 'Day' THEN IIF(f."createdAt" >= NOW() - interval '1 day', 1, 0)
            END
        ), 0)
    FROM (
        SELECT
            f."modelId",
            f."createdAt"
        FROM "ModelEngagement" f
        WHERE ${Prisma.join(sqlAnd, ` AND `)}
    ) f
    JOIN "ModelVersion" mv ON f."modelId" = mv."modelId"
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    GROUP BY mv.id, tf.timeframe
    ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "favoriteCount" = EXCLUDED."favoriteCount";
  `;

  return affectedModels.map(({ modelId }) => modelId);
}

async function updateVersionCommentMetrics({ ch, db, lastUpdate }: MetricProcessorRunContext) {
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
  for (const batch of batches) {
    const batchJson = JSON.stringify(batch);

    await db.$executeRaw`
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
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "commentCount" = EXCLUDED."commentCount";
    `;
  }

  return modelIds;
}

async function updateVersionImageMetrics({ db, lastUpdate }: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelVersionId: number }[]>`
    SELECT DISTINCT
      ir."modelVersionId"
    FROM "Image" i
    JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
    JOIN "Post" p ON i."postId" = p.id
    WHERE p."publishedAt" < now() AND p."publishedAt" > ${lastUpdate};
  `;

  const versionIds = affected.map((x) => x.modelVersionId);

  const batches = chunk(versionIds, 1000);
  for (const batch of batches) {
    const batchJson = JSON.stringify(batch);

    await db.$executeRaw`
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
          FROM "Image" i
          JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" IS NOT NULL
          JOIN "Post" p ON i."postId" = p.id
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE p."publishedAt" < now() AND p."publishedAt" IS NOT NULL
            AND m."userId" != i."userId"
            AND p."modelVersionId" = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
      ) i
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      GROUP BY i."modelVersionId", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "imageCount" = EXCLUDED."imageCount";
    `;
  }

  return getModelIdFromVersions({ versionIds, db });
}

async function updateCollectMetrics({ db, lastUpdate }: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelId: number }[]>`
    SELECT DISTINCT
      "modelId"
    FROM "CollectionItem"
    WHERE "modelId" IS NOT NULL AND "createdAt" > ${lastUpdate};
  `;

  const modelIds = affected.map((x) => x.modelId);

  const batches = chunk(modelIds, 1000);
  for (const batch of batches) {
    const batchJson = JSON.stringify(batch);

    await db.$executeRaw`
      INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "collectedCount")
      SELECT
        mv."id",
        tf.timeframe,
        COALESCE(SUM(
          CASE
            WHEN tf.timeframe = 'AllTime' THEN 1
            WHEN tf.timeframe = 'Year' THEN IIF(i."createdAt" >= NOW() - interval '1 year', 1, 0)
            WHEN tf.timeframe = 'Month' THEN IIF(i."createdAt" >= NOW() - interval '1 month', 1, 0)
            WHEN tf.timeframe = 'Week' THEN IIF(i."createdAt" >= NOW() - interval '1 week', 1, 0)
            WHEN tf.timeframe = 'Day' THEN IIF(i."createdAt" >= NOW() - interval '1 day', 1, 0)
          END
        ), 0)
      FROM (
        SELECT
          "modelId",
          "addedById",
          MAX(c."createdAt") "createdAt"
        FROM "CollectionItem" c
        JOIN "Model" m ON m.id = c."modelId"
        WHERE "modelId" IS NOT NULL
          AND m."userId" != c."addedById"
          AND "modelId" = ANY (SELECT json_array_elements(${batchJson}::json)::text::integer)
        GROUP BY "modelId", "addedById"
      ) i
      JOIN "ModelVersion" mv ON mv."modelId" = i."modelId"
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      GROUP BY mv."id", tf.timeframe
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "collectedCount" = EXCLUDED."collectedCount";
    `;
  }

  return modelIds;
}

async function updateTippedBuzzMetrics({ db, lastUpdate }: MetricProcessorRunContext) {
  const affected = await db.$queryRaw<{ modelId: number }[]>`
    SELECT bt."entityId" as "modelId"
    FROM "BuzzTip" bt
    WHERE bt."entityId" IS NOT NULL AND bt."entityType" = 'Model'
      AND (bt."createdAt" > ${lastUpdate} OR bt."updatedAt" > ${lastUpdate})
  `;

  console.log(affected);

  const modelIds = affected.map((x) => x.modelId);

  const batches = chunk(modelIds, 1000);
  for (const batch of batches) {
    const batchJson = JSON.stringify(batch);

    await db.$executeRaw`
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
      ON CONFLICT ("modelVersionId", timeframe) DO UPDATE SET "tippedCount" = EXCLUDED."tippedCount", "tippedAmountCount" = EXCLUDED."tippedAmountCount";
    `;
  }

  return modelIds;
}

async function updateModelMetrics({ db }: MetricProcessorRunContext) {
  await db.$executeRaw`
    INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", rating, "ratingCount", "favoriteCount", "commentCount", "imageCount", "collectedCount", "tippedCount", "tippedAmountCount")
    SELECT
      mv."modelId",
      mvm.timeframe,
      SUM(mvm."downloadCount") "downloadCount",
      COALESCE(SUM(mvm.rating * mvm."ratingCount") / NULLIF(SUM(mvm."ratingCount"), 0), 0) "rating",
      SUM(mvm."ratingCount") "ratingCount",
      MAX(mvm."favoriteCount") "favoriteCount",
      MAX(mvm."commentCount") "commentCount",
      SUM(mvm."imageCount") "imageCount",
      MAX(mvm."collectedCount") "collectedCount",
      MAX(mvm."tippedCount") "tippedCount",
      MAX(mvm."tippedAmountCount") "tippedAmountCount"
    FROM "ModelVersionMetric" mvm
    JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
    GROUP BY mv."modelId", mvm.timeframe
    ON CONFLICT ("modelId", timeframe) DO UPDATE SET
      "downloadCount" = EXCLUDED."downloadCount",
      rating = EXCLUDED.rating,
      "ratingCount" = EXCLUDED."ratingCount",
      "favoriteCount" = EXCLUDED."favoriteCount",
      "commentCount" = EXCLUDED."commentCount",
      "imageCount" = EXCLUDED."imageCount",
      "collectedCount" = EXCLUDED."collectedCount",
      "tippedCount" = EXCLUDED."tippedCount",
      "tippedAmountCount" = EXCLUDED."tippedAmountCount";
  `;

  return [];
}
// #endregion

// #region [ranks]
async function refreshModelRank({ db }: MetricProcessorRunContext) {
  await db.$executeRaw`DROP TABLE IF EXISTS "ModelRank_New"`;
  await db.$executeRaw`CREATE TABLE "ModelRank_New" AS SELECT * FROM "ModelRank_Live"`;
  await db.$executeRaw`ALTER TABLE "ModelRank_New" ADD CONSTRAINT "pk_ModelRank_New" PRIMARY KEY ("modelId")`;

  await db.$transaction([
    db.$executeRaw`TRUNCATE TABLE "ModelRank"`,
    db.$executeRaw`INSERT INTO "ModelRank" SELECT * FROM "ModelRank_New"`,
  ]);
  db.$executeRaw`VACUUM "ModelRank"`;
  await db.$executeRaw`DROP TABLE IF EXISTS "ModelRank_New"`;
}

async function refreshModelVersionRank({ db }: MetricProcessorRunContext) {
  await db.$executeRaw`DROP TABLE IF EXISTS "ModelVersionRank_New"`;
  await db.$executeRaw`CREATE TABLE "ModelVersionRank_New" AS SELECT * FROM "ModelVersionRank_Live"`;
  await db.$executeRaw`ALTER TABLE "ModelVersionRank_New" ADD CONSTRAINT "pk_ModelVersionRank_New" PRIMARY KEY ("modelVersionId")`;
  await db.$executeRaw`CREATE INDEX "ModelVersionRank_New_idx" ON "ModelVersionRank_New"("modelVersionId")`;

  await db.$transaction([
    db.$executeRaw`DROP TABLE IF EXISTS "ModelVersionRank"`,
    db.$executeRaw`ALTER TABLE "ModelVersionRank_New" RENAME TO "ModelVersionRank"`,
    db.$executeRaw`ALTER TABLE "ModelVersionRank" RENAME CONSTRAINT "pk_ModelVersionRank_New" TO "pk_ModelVersionRank";`,
    db.$executeRaw`ALTER INDEX "ModelVersionRank_New_idx" RENAME TO "ModelVersionRank_idx"`,
  ]);
}
// #endregion

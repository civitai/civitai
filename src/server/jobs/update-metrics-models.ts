import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { clickhouse } from '~/server/clickhouse/client';
import dayjs from 'dayjs';

const log = createLogger('update-metrics', 'blue');

const METRIC_LAST_UPDATED_MODELS_KEY = 'last-metrics-update-models';

export const updateMetricsModelJob = createJob(
  'update-metrics-models',
  '*/1 * * * *',
  async () => {
    // Get the last time this ran from the KeyValue store
    // --------------------------------------
    const dates = await dbWrite.keyValue.findMany({
      where: {
        key: { in: [METRIC_LAST_UPDATED_MODELS_KEY] },
      },
    });
    const lastUpdateDate = new Date(
      (dates.find((d) => d.key === METRIC_LAST_UPDATED_MODELS_KEY)?.value as number) ?? 0
    );
    const lastUpdate = lastUpdateDate.toISOString();

    const updateModelMetrics = async () => {
      const clickhouseLastUpdate = dayjs(lastUpdateDate).format('YYYY-MM-DD');

      async function updateVersionDownloadMetrics() {
        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT mvm."modelVersionId", timeframe.timeframe, mvm."downloadCount", 0, 0, 0, 0
          FROM unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          CROSS JOIN LATERAL (
              SELECT
                  m."modelVersionId",
                  SUM(m.count) AS "downloadCount"
              FROM "ModelMetricDaily" m
              WHERE CASE
                  WHEN timeframe.timeframe = 'Day' THEN m.date >= CURRENT_DATE
                  WHEN timeframe.timeframe = 'Week' THEN m.date >= CURRENT_DATE - interval '1 week'
                  WHEN timeframe.timeframe = 'Month' THEN m.date >= CURRENT_DATE - interval '1 month'
                  WHEN timeframe.timeframe = 'Year' THEN m.date >= CURRENT_DATE - interval '1 year'
                  ELSE true
              END
              GROUP BY m."modelId", m."modelVersionId"
          ) mvm
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "downloadCount" = EXCLUDED."downloadCount";
        `;
      }

      async function updateVersionRatingMetrics() {
        const affectedModelVersionsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT modelVersionId
            FROM resourceReviews
            WHERE createdDate >= '${clickhouseLastUpdate}'
          `,
          format: 'JSONEachRow',
        });

        const affectedModelVersions = (await affectedModelVersionsResponse?.json()) as [
          {
            modelVersionId: number;
          }
        ];

        const affectedModelVersionsJson = JSON.stringify(
          affectedModelVersions.map((x) => x.modelVersionId)
        );

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              rr."modelVersionId",
              tf.timeframe,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= CURRENT_DATE, 1, 0)
                  END
              ), 0),
              COALESCE(AVG(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN rating
                      WHEN tf.timeframe = 'Year' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 year', rating, NULL)
                      WHEN tf.timeframe = 'Month' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 month', rating, NULL)
                      WHEN tf.timeframe = 'Week' THEN IIF(rr.created_at >= CURRENT_DATE - interval '1 week', rating, NULL)
                      WHEN tf.timeframe = 'Day' THEN IIF(rr.created_at >= CURRENT_DATE, rating, NULL)
                  END
              ), 0),
              0,
              0
          FROM (
              SELECT
                  r."userId",
                  r."modelVersionId",
                  MAX(r.rating) rating,
                  MAX(r."createdAt") AS created_at
              FROM "ResourceReview" r
              JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
              WHERE r.exclude = FALSE
              AND r."tosViolation" = FALSE
              AND r."modelVersionId" = ANY (SELECT json_array_elements(${affectedModelVersionsJson}::json)::text::integer)
              GROUP BY r."userId", r."modelVersionId"
          ) rr
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY rr."modelVersionId", tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating;
        `;
      }

      async function updateVersionFavoriteMetrics() {
        const affectedModelsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT modelId
            FROM modelEngagements
            WHERE createdDate >= '${clickhouseLastUpdate}'
            AND type = 'Favorite'
          `,
          format: 'JSONEachRow',
        });

        const effectedModels = (await affectedModelsResponse?.json()) as [
          {
            modelId: number;
          }
        ];

        const affectedModelsJson = JSON.stringify(effectedModels.map((x) => x.modelId));

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              mv."id",
              tf.timeframe,
              0,
              0,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(f."createdAt" >= CURRENT_DATE - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(f."createdAt" >= CURRENT_DATE - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(f."createdAt" >= CURRENT_DATE - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(f."createdAt" >= CURRENT_DATE, 1, 0)
                  END
              ), 0),
              0
          FROM (
              SELECT
                  f."modelId",
                  f."createdAt"
              FROM "ModelEngagement" f
              WHERE f.type = 'Favorite'
              AND f."modelId" = ANY (SELECT json_array_elements(${affectedModelsJson}::json)::text::integer)
          ) f
          JOIN "ModelVersion" mv ON f."modelId" = mv."modelId"
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY mv.id, tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "favoriteCount" = EXCLUDED."favoriteCount";
        `;
      }

      async function updateVersionCommentMetrics() {
        const affectedModelsResponse = await clickhouse?.query({
          query: `
            SELECT DISTINCT entityId AS modelId
            FROM comments
            WHERE createdDate >= '${clickhouseLastUpdate}'
            AND type = 'Model'
          `,
          format: 'JSONEachRow',
        });

        const affectedModels = (await affectedModelsResponse?.json()) as [
          {
            modelId: number;
          }
        ];

        const affectedModelsJson = JSON.stringify(affectedModels.map((x) => x.modelId));

        await dbWrite.$executeRaw`
          INSERT INTO "ModelVersionMetric" ("modelVersionId", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
          SELECT
              mv."id",
              tf.timeframe,
              0,
              0,
              0,
              0,
              COALESCE(SUM(
                  CASE
                      WHEN tf.timeframe = 'AllTime' THEN 1
                      WHEN tf.timeframe = 'Year' THEN IIF(c."createdAt" >= CURRENT_DATE - interval '1 year', 1, 0)
                      WHEN tf.timeframe = 'Month' THEN IIF(c."createdAt" >= CURRENT_DATE - interval '1 month', 1, 0)
                      WHEN tf.timeframe = 'Week' THEN IIF(c."createdAt" >= CURRENT_DATE - interval '1 week', 1, 0)
                      WHEN tf.timeframe = 'Day' THEN IIF(c."createdAt" >= CURRENT_DATE, 1, 0)
                  END
              ), 0)
          FROM (
              SELECT
                  c."modelId",
                  c."createdAt"
              FROM "Comment" c
              WHERE c."tosViolation" = false
              AND c."modelId" = ANY (SELECT json_array_elements(${affectedModelsJson}::json)::text::integer)
          ) c
          JOIN "ModelVersion" mv ON c."modelId" = mv."modelId"
          CROSS JOIN (
            SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
          GROUP BY mv.id, tf.timeframe
          ON CONFLICT ("modelVersionId", timeframe) DO UPDATE
              SET "commentCount" = EXCLUDED."commentCount";
        `;
      }

      async function updateModelMetrics() {
        await dbWrite.$executeRaw`
          INSERT INTO "ModelMetric" ("modelId", timeframe, "downloadCount", rating, "ratingCount", "favoriteCount", "commentCount")
          SELECT mv."modelId", mvm.timeframe, SUM(mvm."downloadCount"), COALESCE(SUM(mvm.rating * mvm."ratingCount") / NULLIF(SUM(mvm."ratingCount"), 0), 0), SUM(mvm."ratingCount"), SUM(mvm."favoriteCount"), SUM(mvm."commentCount")
          FROM "ModelVersionMetric" mvm
          JOIN "ModelVersion" mv ON mvm."modelVersionId" = mv.id
          GROUP BY mv."modelId", mvm.timeframe
          ON CONFLICT ("modelId", timeframe) DO UPDATE
              SET  "downloadCount" = EXCLUDED."downloadCount", rating = EXCLUDED.rating, "ratingCount" = EXCLUDED."ratingCount", "favoriteCount" = EXCLUDED."favoriteCount", "commentCount" = EXCLUDED."commentCount";
        `;
      }

      await updateVersionDownloadMetrics();
      await updateVersionRatingMetrics();
      await updateVersionFavoriteMetrics();
      await updateVersionCommentMetrics();

      // Update model metrics after all version metrics have been computed
      await updateModelMetrics();
    };

    const refreshModelRank = async () => {
      await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelRank_New";`);
      await dbWrite.$executeRawUnsafe(
        `CREATE TABLE "ModelRank_New" AS SELECT * FROM "ModelRank_Live";`
      );
      await dbWrite.$executeRawUnsafe(
        `ALTER TABLE "ModelRank_New" ADD CONSTRAINT "pk_ModelRank_New" PRIMARY KEY ("modelId")`
      );

      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`TRUNCATE TABLE "ModelRank"`),
        dbWrite.$executeRawUnsafe(`INSERT INTO "ModelRank" SELECT * FROM "ModelRank_New"`),
      ]);
      dbWrite.$executeRawUnsafe(`VACUUM "ModelRank"`);
    };

    const refreshVersionModelRank = async () => {
      await dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelVersionRank_New";`);
      await dbWrite.$executeRawUnsafe(
        `CREATE TABLE "ModelVersionRank_New" AS SELECT * FROM "ModelVersionRank_Live";`
      );
      await dbWrite.$executeRawUnsafe(
        `ALTER TABLE "ModelVersionRank_New" ADD CONSTRAINT "pk_ModelVersionRank_New" PRIMARY KEY ("modelVersionId")`
      );
      await dbWrite.$executeRawUnsafe(
        `CREATE INDEX "ModelVersionRank_New_idx" ON "ModelVersionRank_New"("modelVersionId")`
      );

      await dbWrite.$transaction([
        dbWrite.$executeRawUnsafe(`DROP TABLE IF EXISTS "ModelVersionRank";`),
        dbWrite.$executeRawUnsafe(
          `ALTER TABLE "ModelVersionRank_New" RENAME TO "ModelVersionRank";`
        ),
        dbWrite.$executeRawUnsafe(
          `ALTER TABLE "ModelVersionRank" RENAME CONSTRAINT "pk_ModelVersionRank_New" TO "pk_ModelVersionRank";`
        ),
        dbWrite.$executeRawUnsafe(
          `ALTER INDEX "ModelVersionRank_New_idx" RENAME TO "ModelVersionRank_idx";`
        ),
      ]);
    };

    const clearDayMetrics = async () =>
      await Promise.all(
        [
          `UPDATE "ModelMetric" SET "downloadCount" = 0, "ratingCount" = 0, rating = 0, "favoriteCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
          `UPDATE "ModelVersionMetric" SET "downloadCount" = 0, "ratingCount" = 0, rating = 0, "favoriteCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';`,
        ].map((x) => dbWrite.$executeRawUnsafe(x))
      );

    // If this is the first metric update of the day, reset the day metrics
    // -------------------------------------------------------------------
    if (lastUpdateDate.getDate() !== new Date().getDate()) {
      await clearDayMetrics();
      log('Cleared day metrics');
    }

    // Update all affected metrics
    // --------------------------------------------
    await updateModelMetrics();
    log('Updated model metrics');

    // Update the last update time
    // --------------------------------------------
    await dbWrite?.keyValue.upsert({
      where: { key: METRIC_LAST_UPDATED_MODELS_KEY },
      create: { key: METRIC_LAST_UPDATED_MODELS_KEY, value: new Date().getTime() },
      update: { value: new Date().getTime() },
    });

    // Update rank views
    // --------------------------------------------
    await refreshVersionModelRank();
    await refreshModelRank();
  },
  {
    lockExpiration: 10 * 60,
  }
);

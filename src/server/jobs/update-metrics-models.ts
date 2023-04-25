import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';

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

    const updateModelMetrics = async (target: 'models' | 'versions') => {
      const [tableName, tableId, viewName, viewId] =
        target === 'models'
          ? ['ModelMetric', 'modelId', 'affected_models', 'model_id']
          : ['ModelVersionMetric', 'modelVersionId', 'affected_versions', 'model_version_id'];

      await dbWrite.$executeRawUnsafe(`
        -- Get all user activities that have happened since then that affect metrics
        WITH recent_activities AS
        (
          SELECT
            CAST(a.details ->> 'modelId' AS INT) AS model_id,
            CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id
          FROM "UserActivity" a
          WHERE (a."createdAt" > '${lastUpdate}')
          AND (a.activity IN ('ModelDownload'))

          UNION

          SELECT muq.id AS model_id, mv.id AS model_version_id
          FROM "MetricUpdateQueue" muq
          JOIN "ModelVersion" mv ON mv."modelId" = muq.id
          WHERE type = 'Model'
        ),
        -- Get all reviews that have been created/updated since then
        recent_reviews AS
        (
          SELECT
            r."modelId" AS model_id,
            r."modelVersionId" AS model_version_id
          FROM "ResourceReview" r
          WHERE (r."createdAt" > '${lastUpdate}' OR r."updatedAt" > '${lastUpdate}')
        ),
        -- Get all favorites that have been created since then
        recent_favorites AS
        (
          SELECT
            "modelId" AS model_id
          FROM "ModelEngagement"
          WHERE ("createdAt" > '${lastUpdate}') AND type = 'Favorite'
        ),
        -- Get all comments that have been created since then
        --recent_comments AS
        --(
        --  SELECT
        --    t."modelId" AS model_id
        --  FROM "CommentV2" c
        --  JOIN "Thread" ct ON ct.id = c."threadId" AND ct."commentId" IS NOT NULL
        --  JOIN "CommentV2" p ON p.id = ct."commentId"
        --  JOIN "Thread" t ON t.id = p."threadId"
        --  WHERE (c."createdAt" > '${lastUpdate}')
        --
        --  UNION ALL
        --
        --  SELECT
        --    t."modelId" AS model_id
        --  FROM "CommentV2" c
        --  JOIN "Thread" t ON t.id = c."threadId" AND t."modelId" IS NOT NULL
        --  WHERE (c."createdAt" > '${lastUpdate}')
        --),
        -- Bring back the old comments table for now
        recent_comments AS
        (
          SELECT
            "modelId" AS model_id
          FROM "Comment"
          WHERE ("createdAt" > '${lastUpdate}')
        ),
        -- Get all affected models
        affected_models AS
        (
            SELECT DISTINCT
                r.model_id
            FROM recent_reviews r
            WHERE r.model_id IS NOT NULL

            UNION

            SELECT DISTINCT
                f.model_id
            FROM recent_favorites f

            UNION

            SELECT DISTINCT
                model_id
            FROM recent_comments c

            UNION

            SELECT DISTINCT
                a.model_id
            FROM recent_activities a
            JOIN "Model" m ON m.Id = a.model_id
            WHERE a.model_id IS NOT NULL
        ),
        -- Get all affected versions
        affected_versions AS
        (
            SELECT DISTINCT
                r.model_version_id,
                r.model_id
            FROM recent_reviews r
            WHERE r.model_version_id IS NOT NULL

            UNION

            SELECT DISTINCT
                a.model_version_id,
                a.model_id
            FROM recent_activities a
            JOIN "ModelVersion" m ON m.Id = a.model_version_id
            WHERE a.model_version_id IS NOT NULL
        )

        -- upsert metrics for all affected models
        -- perform a one-pass table scan producing all metrics for all affected models
        INSERT INTO "${tableName}" ("${tableId}", timeframe, "downloadCount", "ratingCount", rating, "favoriteCount", "commentCount")
        SELECT
          m.${viewId},
          tf.timeframe,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN download_count
            WHEN tf.timeframe = 'Year' THEN year_download_count
            WHEN tf.timeframe = 'Month' THEN month_download_count
            WHEN tf.timeframe = 'Week' THEN week_download_count
            WHEN tf.timeframe = 'Day' THEN day_download_count
          END AS download_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN rating_count
            WHEN tf.timeframe = 'Year' THEN year_rating_count
            WHEN tf.timeframe = 'Month' THEN month_rating_count
            WHEN tf.timeframe = 'Week' THEN week_rating_count
            WHEN tf.timeframe = 'Day' THEN day_rating_count
          END AS rating_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN rating
            WHEN tf.timeframe = 'Year' THEN year_rating
            WHEN tf.timeframe = 'Month' THEN month_rating
            WHEN tf.timeframe = 'Week' THEN week_rating
            WHEN tf.timeframe = 'Day' THEN day_rating
          END AS rating,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN favorite_count
            WHEN tf.timeframe = 'Year' THEN year_favorite_count
            WHEN tf.timeframe = 'Month' THEN month_favorite_count
            WHEN tf.timeframe = 'Week' THEN week_favorite_count
            WHEN tf.timeframe = 'Day' THEN day_favorite_count
          END AS favorite_count,
          CASE
            WHEN tf.timeframe = 'AllTime' THEN comment_count
            WHEN tf.timeframe = 'Year' THEN year_comment_count
            WHEN tf.timeframe = 'Month' THEN month_comment_count
            WHEN tf.timeframe = 'Week' THEN week_comment_count
            WHEN tf.timeframe = 'Day' THEN day_comment_count
          END AS comment_count
        FROM
        (
          SELECT
            m.${viewId},
            COALESCE(ds.download_count, 0) AS download_count,
            COALESCE(ds.year_download_count, 0) AS year_download_count,
            COALESCE(ds.month_download_count, 0) AS month_download_count,
            COALESCE(ds.week_download_count, 0) AS week_download_count,
            COALESCE(ds.day_download_count, 0) AS day_download_count,
            COALESCE(rs.rating_count, 0) AS rating_count,
            COALESCE(rs.rating, 0) AS rating,
            COALESCE(rs.year_rating_count, 0) AS year_rating_count,
            COALESCE(rs.year_rating, 0) AS year_rating,
            COALESCE(rs.month_rating_count, 0) AS month_rating_count,
            COALESCE(rs.month_rating, 0) AS month_rating,
            COALESCE(rs.week_rating_count, 0) AS week_rating_count,
            COALESCE(rs.week_rating, 0) AS week_rating,
            COALESCE(rs.day_rating_count, 0) AS day_rating_count,
            COALESCE(rs.day_rating, 0) AS day_rating,
            COALESCE(fs.favorite_count, 0) AS favorite_count,
            COALESCE(fs.year_favorite_count, 0) AS year_favorite_count,
            COALESCE(fs.month_favorite_count, 0) AS month_favorite_count,
            COALESCE(fs.week_favorite_count, 0) AS week_favorite_count,
            COALESCE(fs.day_favorite_count, 0) AS day_favorite_count,
            COALESCE(cs.comment_count, 0) AS comment_count,
            COALESCE(cs.year_comment_count, 0) AS year_comment_count,
            COALESCE(cs.month_comment_count, 0) AS month_comment_count,
            COALESCE(cs.week_comment_count, 0) AS week_comment_count,
            COALESCE(cs.day_comment_count, 0) AS day_comment_count
          FROM ${viewName} m
          LEFT JOIN (
            SELECT
              ${viewId},
              SUM(download_count) download_count,
              SUM(year_download_count) year_download_count,
              SUM(month_download_count) month_download_count,
              SUM(week_download_count) week_download_count,
              SUM(day_download_count) day_download_count
            FROM (
              (
                SELECT
                  a.${viewId},
                  COUNT(a.${viewId}) AS download_count,
                  SUM(CASE WHEN a.created_at >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_download_count,
                  SUM(CASE WHEN a.created_at >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_download_count,
                  SUM(CASE WHEN a.created_at >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_download_count,
                  SUM(CASE WHEN a.created_at >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_download_count
                FROM
                (
                  SELECT
                    user_id,
                    ${viewId},
                    MAX(created_at) created_at
                  FROM (
                    SELECT
                      COALESCE(CAST(a."userId" as text), a.details->>'ip') user_id,
                      CAST(a.details ->> 'modelId' AS INT) AS model_id,
                      CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id,
                      a."createdAt" AS created_at
                    FROM "UserActivity" a
                    WHERE a.activity = 'ModelDownload' AND a."createdAt" > current_date
                  ) t
                  JOIN "ModelVersion" mv ON mv.id = t.model_version_id
                  GROUP BY user_id, model_id, model_version_id
                ) a
                GROUP BY a.${viewId}
              )
              UNION ALL
              (
                SELECT
                  "${tableId}" ${viewId},
                  SUM(count) download_count,
                  SUM(CASE WHEN date >= (NOW() - interval '365 days') THEN count ELSE 0 END) AS year_download_count,
                  SUM(CASE WHEN date >= (NOW() - interval '30 days') THEN count ELSE 0 END) AS month_download_count,
                  SUM(CASE WHEN date >= (NOW() - interval '7 days') THEN count ELSE 0 END) AS week_download_count,
                  SUM(CASE WHEN date >= (NOW() - interval '1 days') THEN count ELSE 0 END) AS day_download_count
                FROM "ModelMetricDaily"
                GROUP BY "${tableId}"
              )
            ) agg
            GROUP BY agg.${viewId}
          ) ds ON m.${viewId} = ds.${viewId}
          LEFT JOIN (
            SELECT
              r.${viewId},
              COUNT(r.${viewId}) AS rating_count,
              AVG(r.rating) AS rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '365 days') THEN r.rating ELSE NULL END) AS year_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '30 days') THEN r.rating ELSE NULL END) AS month_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '7 days') THEN r.rating ELSE NULL END) AS week_rating,
              SUM(CASE WHEN r.created_at >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_rating_count,
              AVG(CASE WHEN r.created_at >= (NOW() - interval '1 days') THEN r.rating ELSE NULL END) AS day_rating
            FROM
            (
              SELECT
                r."userId",
                r."${tableId}" AS ${viewId},
                MAX(r.rating) rating,
                MAX(r."createdAt") AS created_at
              FROM "ResourceReview" r
              JOIN "Model" m ON m.id = r."modelId" AND m."userId" != r."userId"
              WHERE r.exclude = FALSE AND r."tosViolation" = FALSE
              GROUP BY r."userId", r."${tableId}"
            ) r
            GROUP BY r.${viewId}
          ) rs ON m.${viewId} = rs.${viewId}
          LEFT JOIN (
            SELECT
              f."modelId" AS model_id,
              COUNT(f."modelId") AS favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_favorite_count,
              SUM(CASE WHEN f."createdAt" >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_favorite_count
            FROM "ModelEngagement" f
            WHERE type = 'Favorite'
            GROUP BY f."modelId"
          ) fs ON m.model_id = fs.model_id
          LEFT JOIN (
            SELECT
              c."modelId" AS model_id,
              COUNT(c.id) AS comment_count,
              SUM(CASE WHEN c."createdAt" >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_comment_count,
              SUM(CASE WHEN c."createdAt" >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_comment_count,
              SUM(CASE WHEN c."createdAt" >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_comment_count,
              SUM(CASE WHEN c."createdAt" >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_comment_count
            -- FROM (
            --   SELECT
            --     t."modelId",
            --     c.id,
            --     c."createdAt"
            --   FROM "CommentV2" c
            --   JOIN "Thread" t ON t.id = c."threadId" AND t."modelId" IS NOT NULL
            --   WHERE c."tosViolation" = FALSE
            --   UNION
            --   SELECT
            --     t."modelId",
            --     c.id,
            --     c."createdAt"
            --   FROM "CommentV2" p
            --   JOIN "Thread" t ON t.id = p."threadId" AND t."modelId" IS NOT NULL
            --   JOIN "Thread" ct ON ct."commentId" = p.id
            --   JOIN "CommentV2" c ON c."threadId" = ct.id
            --   WHERE c."tosViolation" = FALSE
            -- ) c

            -- Bring back old comment count until we switch to v2
            FROM "Comment" c WHERE "tosViolation" = FALSE
            GROUP BY c."modelId"
          ) cs ON m.model_id = cs.model_id
        ) m
        CROSS JOIN (
          SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
        ) tf
        ON CONFLICT ("${tableId}", timeframe) DO UPDATE
          SET "downloadCount" = EXCLUDED."downloadCount", "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating, "favoriteCount" = EXCLUDED."favoriteCount", "commentCount" = EXCLUDED."commentCount";
        `);

      if (target === 'versions')
        await dbWrite.$executeRawUnsafe(`DELETE FROM "MetricUpdateQueue" WHERE type = 'Model'`);
    };

    const refreshModelRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "ModelRank"');

    const refreshVersionModelRank = async () =>
      await dbWrite.$executeRawUnsafe('REFRESH MATERIALIZED VIEW CONCURRENTLY "ModelVersionRank"');

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
    await updateModelMetrics('models');
    await updateModelMetrics('versions');
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

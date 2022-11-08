import { MetricTimeframe, Prisma, UserActivityType } from '@prisma/client';
import { JobEndpoint } from '~/server/common/jobs';
import { prisma } from '~/server/db/client';

const METRIC_LAST_UPDATED_KEY = 'last-metrics-update';

export default JobEndpoint(async (req, res) => {
  // Get the last time this ran from the KeyValue store
  // --------------------------------------
  const lastUpdate = new Date(
    ((
      await prisma.keyValue.findUnique({
        where: { key: METRIC_LAST_UPDATED_KEY },
      })
    )?.value as number) ?? 0
  );

  const updateMetrics = async (target: "models" | "versions") => {
    const [tableName, tableId, viewName, viewId] = target === "models"
      ? ["ModelMetric", "modelId", "affected_models", "model_id"]
      : ["ModelVersionMetric", "modelVersionId", "affected_versions", "model_version_id"];

    await prisma?.$queryRawUnsafe(`
      -- Get all user activities that have happened since then that affect metrics
      WITH recent_activities AS 
      (
        SELECT 
          CAST(a.details ->> 'modelId' AS INT) AS model_id,
          CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id
        FROM "UserActivity" a
        WHERE (a."createdAt" > '${lastUpdate.toISOString()}')
        AND (a.activity IN ('ModelDownload'))
        
      ),
      -- Get all reviews that have been created/updated since then
      recent_reviews AS
      (
        SELECT 
          r."modelId" AS model_id,
          r."modelVersionId" AS model_version_id
        FROM "Review" r
        WHERE (r."createdAt" > '${lastUpdate.toISOString()}' OR r."updatedAt" > '${lastUpdate.toISOString()}')
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
              a.model_id
          FROM recent_activities a
          WHERE a.model_id IS NOT NULL
      ),
      -- Get all affected versions
      affected_versions AS 
      (
          SELECT DISTINCT
              r.model_version_id
          FROM recent_reviews r
          WHERE r.model_version_id IS NOT NULL
      
          UNION
          
          SELECT DISTINCT 
              a.model_version_id
          FROM recent_activities a
          WHERE a.model_version_id IS NOT NULL
      )
      
      -- upsert metrics for all affected models
      -- perform a one-pass table scan producing all metrics for all affected models
      INSERT INTO "${tableName}" ("${tableId}", timeframe, "downloadCount", "ratingCount", rating) 
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
        END AS rating
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
          COALESCE(rs.day_rating, 0) AS day_rating
        FROM ${viewName} m 
        LEFT JOIN (
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
              CAST(a.details ->> '${tableId}' AS INT) AS ${viewId},
              a."createdAt" AS created_at
            FROM "UserActivity" a
          ) a
          GROUP BY a.${viewId}
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
              r."${tableId}" AS ${viewId},
              r.rating,
              r."createdAt" AS created_at
            FROM "Review" r
          ) r
          GROUP BY r.${viewId}
        ) rs ON m.${viewId} = rs.${viewId}
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("${tableId}", timeframe) DO UPDATE 
        SET "downloadCount" = EXCLUDED."downloadCount", "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating;
      `);
  }

  // If this is the first metric update of the day, reset the day metrics
  // -------------------------------------------------------------------
  if (lastUpdate.getDate() !== new Date().getDate()) {
    await prisma?.modelMetric.updateMany({
      where: { timeframe: MetricTimeframe.Day },
      data: {
        downloadCount: 0,
        ratingCount: 0,
        rating: 0,
      },
    });
  }

  // Update all affected metrics
  // --------------------------------------------
  await updateMetrics("models");
  await updateMetrics("versions");

  // Update the last update time
  // --------------------------------------------
  await prisma?.keyValue.upsert({
    where: { key: METRIC_LAST_UPDATED_KEY },
    create: { key: METRIC_LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });

  res.status(200).json({ ok: true });
});

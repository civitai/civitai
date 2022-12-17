import { createJob } from './job';
import { MetricTimeframe } from '@prisma/client';
import { prisma } from '~/server/db/client';

const METRIC_LAST_UPDATED_KEY = 'last-metrics-update';
export const updateMetricsJob = createJob('update-metrics', '*/1 * * * *', async () => {
  // Get the last time this ran from the KeyValue store
  // --------------------------------------
  const lastUpdateDate = new Date(
    ((
      await prisma.keyValue.findUnique({
        where: { key: METRIC_LAST_UPDATED_KEY },
      })
    )?.value as number) ?? 0
  );
  const lastUpdate = lastUpdateDate.toISOString();

  const updateModelMetrics = async (target: 'models' | 'versions') => {
    const [tableName, tableId, viewName, viewId] =
      target === 'models'
        ? ['ModelMetric', 'modelId', 'affected_models', 'model_id']
        : ['ModelVersionMetric', 'modelVersionId', 'affected_versions', 'model_version_id'];

    await prisma.$queryRawUnsafe(`
        -- Get all user activities that have happened since then that affect metrics
        WITH recent_activities AS
        (
          SELECT
            CAST(a.details ->> 'modelId' AS INT) AS model_id,
            CAST(a.details ->> 'modelVersionId' AS INT) AS model_version_id
          FROM "UserActivity" a
          WHERE (a."createdAt" > '${lastUpdate}')
          AND (a.activity IN ('ModelDownload'))

        ),
        -- Get all reviews that have been created/updated since then
        recent_reviews AS
        (
          SELECT
            r."modelId" AS model_id,
            r."modelVersionId" AS model_version_id
          FROM "Review" r
          WHERE (r."createdAt" > '${lastUpdate}' OR r."updatedAt" > '${lastUpdate}')
        ),
        -- Get all favorites that have been created since then
        recent_favorites AS
        (
          SELECT
            "modelId" AS model_id
          FROM "FavoriteModel"
          WHERE ("createdAt" > '${lastUpdate}')
        ),
        -- Get all comments that have been created since then
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
                c.model_id
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
                r."userId",
                r."${tableId}" AS ${viewId},
                MAX(r.rating) rating,
                MAX(r."createdAt") AS created_at
              FROM "Review" r
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
            FROM "FavoriteModel" f
            GROUP BY f."modelId"
          ) fs ON m.model_id = fs.model_id
          LEFT JOIN (
            SELECT
              "modelId" AS model_id,
              COUNT("modelId") AS comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '365 days') THEN 1 ELSE 0 END) AS year_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '30 days') THEN 1 ELSE 0 END) AS month_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '7 days') THEN 1 ELSE 0 END) AS week_comment_count,
              SUM(CASE WHEN "createdAt" >= (NOW() - interval '1 days') THEN 1 ELSE 0 END) AS day_comment_count
            FROM "Comment"
            GROUP BY "modelId"
          ) cs ON m.model_id = cs.model_id
        ) m
        CROSS JOIN (
          SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
        ) tf
        ON CONFLICT ("${tableId}", timeframe) DO UPDATE
          SET "downloadCount" = EXCLUDED."downloadCount", "ratingCount" = EXCLUDED."ratingCount", rating = EXCLUDED.rating, "favoriteCount" = EXCLUDED."favoriteCount", "commentCount" = EXCLUDED."commentCount";
        `);
  };

  const updateUserMetrics = async () => {
    await prisma.$queryRawUnsafe(`
      -- Get all user engagements that have happened since then that affect metrics
      WITH recent_engagements AS
      (
        SELECT
          a."userId" AS user_id
        FROM "UserEngagement" a
        WHERE (a."createdAt" > '${lastUpdate}')

        UNION

        SELECT
          a."targetUserId" AS user_id
        FROM "UserEngagement" a
        WHERE (a."createdAt" > '${lastUpdate}')
      ),
      -- Get all affected users
      affected_users AS
      (
          SELECT DISTINCT
              r.user_id
          FROM recent_engagements r
          WHERE r.user_id IS NOT NULL
      )

      -- upsert metrics for all affected users
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "UserMetric" ("userId", timeframe, "followingCount", "followerCount", "hiddenCount")
      SELECT
        m.user_id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN following_count
          WHEN tf.timeframe = 'Year' THEN year_following_count
          WHEN tf.timeframe = 'Month' THEN month_following_count
          WHEN tf.timeframe = 'Week' THEN week_following_count
          WHEN tf.timeframe = 'Day' THEN day_following_count
        END AS following_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN follower_count
          WHEN tf.timeframe = 'Year' THEN year_follower_count
          WHEN tf.timeframe = 'Month' THEN month_follower_count
          WHEN tf.timeframe = 'Week' THEN week_follower_count
          WHEN tf.timeframe = 'Day' THEN day_follower_count
        END AS follower_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN hidden_count
          WHEN tf.timeframe = 'Year' THEN year_hidden_count
          WHEN tf.timeframe = 'Month' THEN month_hidden_count
          WHEN tf.timeframe = 'Week' THEN week_hidden_count
          WHEN tf.timeframe = 'Day' THEN day_hidden_count
        END AS hidden_count
      FROM
      (
        SELECT
          m.user_id,
          COALESCE(fs.following_count, 0) AS following_count,
          COALESCE(fs.year_following_count, 0) AS year_following_count,
          COALESCE(fs.month_following_count, 0) AS month_following_count,
          COALESCE(fs.week_following_count, 0) AS week_following_count,
          COALESCE(fs.day_following_count, 0) AS day_following_count,
          COALESCE(ft.follower_count, 0) AS follower_count,
          COALESCE(ft.year_follower_count, 0) AS year_follower_count,
          COALESCE(ft.month_follower_count, 0) AS month_follower_count,
          COALESCE(ft.week_follower_count, 0) AS week_follower_count,
          COALESCE(ft.day_follower_count, 0) AS day_follower_count,
          COALESCE(ft.hidden_count, 0) AS hidden_count,
          COALESCE(ft.year_hidden_count, 0) AS year_hidden_count,
          COALESCE(ft.month_hidden_count, 0) AS month_hidden_count,
          COALESCE(ft.week_hidden_count, 0) AS week_hidden_count,
          COALESCE(ft.day_hidden_count, 0) AS day_hidden_count
        FROM affected_users m
        LEFT JOIN (
          SELECT
            ue."userId" AS user_id,
            SUM(IIF(ue.type = 'Follow', 1, 0)) AS following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_following_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_following_count
          FROM "UserEngagement" ue
          GROUP BY ue."userId"
        ) fs ON m.user_id = fs.user_id
        LEFT JOIN (
          SELECT
            ue."targetUserId" AS user_id,
            SUM(IIF(ue.type = 'Follow', 1, 0)) AS follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_follower_count,
            SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_follower_count,
            SUM(IIF(ue.type = 'Hide', 1, 0)) AS hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_hidden_count,
            SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_hidden_count
          FROM "UserEngagement" ue
          GROUP BY ue."targetUserId"
        ) ft ON m.user_id = ft.user_id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("userId", timeframe) DO UPDATE
        SET "followerCount" = EXCLUDED."followerCount", "followingCount" = EXCLUDED."followingCount", "hiddenCount" = EXCLUDED."hiddenCount";
    `);
  };

  // If this is the first metric update of the day, reset the day metrics
  // -------------------------------------------------------------------
  if (lastUpdateDate.getDate() !== new Date().getDate()) {
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
  await updateModelMetrics('models');
  await updateModelMetrics('versions');
  await updateUserMetrics();

  // Update the last update time
  // --------------------------------------------
  await prisma?.keyValue.upsert({
    where: { key: METRIC_LAST_UPDATED_KEY },
    create: { key: METRIC_LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});

import { createMetricProcessor } from '~/server/metrics/base.metrics';
import { Prisma } from '@prisma/client';

export const clubPostMetrics = createMetricProcessor({
  name: 'ClubPost',
  async update({ db, lastUpdate }) {
    return;
    // Disabled for now

    const recentEngagementSubquery = Prisma.sql`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
        "clubPostId" AS id
      FROM "ClubPostReaction"
      WHERE ("updatedAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "ClubPost"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'ClubPost'
    )
    `;

    await db.$executeRaw`
      ${recentEngagementSubquery},
      -- Get all affected
      affected AS
      (
          SELECT DISTINCT
              r.id
          FROM recent_engagements r
          JOIN "ClubPost" b ON b.id = r.id
          WHERE r.id IS NOT NULL
      )
      -- upsert metrics for all affected
      -- perform a one-pass table scan producing all metrics for all affected users
      INSERT INTO "ClubPostMetric" ("clubPostId", timeframe, "likeCount", "dislikeCount", "laughCount", "cryCount", "heartCount")
      SELECT
        m.id,
        tf.timeframe,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN like_count
          WHEN tf.timeframe = 'Year' THEN year_like_count
          WHEN tf.timeframe = 'Month' THEN month_like_count
          WHEN tf.timeframe = 'Week' THEN week_like_count
          WHEN tf.timeframe = 'Day' THEN day_like_count
        END AS like_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN dislike_count
          WHEN tf.timeframe = 'Year' THEN year_dislike_count
          WHEN tf.timeframe = 'Month' THEN month_dislike_count
          WHEN tf.timeframe = 'Week' THEN week_dislike_count
          WHEN tf.timeframe = 'Day' THEN day_dislike_count
        END AS dislike_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN laugh_count
          WHEN tf.timeframe = 'Year' THEN year_laugh_count
          WHEN tf.timeframe = 'Month' THEN month_laugh_count
          WHEN tf.timeframe = 'Week' THEN week_laugh_count
          WHEN tf.timeframe = 'Day' THEN day_laugh_count
        END AS laugh_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN cry_count
          WHEN tf.timeframe = 'Year' THEN year_cry_count
          WHEN tf.timeframe = 'Month' THEN month_cry_count
          WHEN tf.timeframe = 'Week' THEN week_cry_count
          WHEN tf.timeframe = 'Day' THEN day_cry_count
        END AS cry_count,
        CASE
          WHEN tf.timeframe = 'AllTime' THEN heart_count
          WHEN tf.timeframe = 'Year' THEN year_heart_count
          WHEN tf.timeframe = 'Month' THEN month_heart_count
          WHEN tf.timeframe = 'Week' THEN week_heart_count
          WHEN tf.timeframe = 'Day' THEN day_heart_count
        END AS heart_count
      FROM
      (
        SELECT
          a.id,
          COALESCE(cpr.heart_count, 0) AS heart_count,
          COALESCE(cpr.year_heart_count, 0) AS year_heart_count,
          COALESCE(cpr.month_heart_count, 0) AS month_heart_count,
          COALESCE(cpr.week_heart_count, 0) AS week_heart_count,
          COALESCE(cpr.day_heart_count, 0) AS day_heart_count,
          COALESCE(cpr.laugh_count, 0) AS laugh_count,
          COALESCE(cpr.year_laugh_count, 0) AS year_laugh_count,
          COALESCE(cpr.month_laugh_count, 0) AS month_laugh_count,
          COALESCE(cpr.week_laugh_count, 0) AS week_laugh_count,
          COALESCE(cpr.day_laugh_count, 0) AS day_laugh_count,
          COALESCE(cpr.cry_count, 0) AS cry_count,
          COALESCE(cpr.year_cry_count, 0) AS year_cry_count,
          COALESCE(cpr.month_cry_count, 0) AS month_cry_count,
          COALESCE(cpr.week_cry_count, 0) AS week_cry_count,
          COALESCE(cpr.day_cry_count, 0) AS day_cry_count,
          COALESCE(cpr.dislike_count, 0) AS dislike_count,
          COALESCE(cpr.year_dislike_count, 0) AS year_dislike_count,
          COALESCE(cpr.month_dislike_count, 0) AS month_dislike_count,
          COALESCE(cpr.week_dislike_count, 0) AS week_dislike_count,
          COALESCE(cpr.day_dislike_count, 0) AS day_dislike_count,
          COALESCE(cpr.like_count, 0) AS like_count,
          COALESCE(cpr.year_like_count, 0) AS year_like_count,
          COALESCE(cpr.month_like_count, 0) AS month_like_count,
          COALESCE(cpr.week_like_count, 0) AS week_like_count,
          COALESCE(cpr.day_like_count, 0) AS day_like_count
        FROM affected a
        LEFT JOIN (
          SELECT
            cpr."clubPostId",
            SUM(IIF(cpr.reaction = 'Heart', 1, 0)) AS heart_count,
            SUM(IIF(cpr.reaction = 'Heart' AND cpr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
            SUM(IIF(cpr.reaction = 'Heart' AND cpr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
            SUM(IIF(cpr.reaction = 'Heart' AND cpr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
            SUM(IIF(cpr.reaction = 'Heart' AND cpr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count,
            SUM(IIF(cpr.reaction = 'Like', 1, 0)) AS like_count,
            SUM(IIF(cpr.reaction = 'Like' AND cpr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_like_count,
            SUM(IIF(cpr.reaction = 'Like' AND cpr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_like_count,
            SUM(IIF(cpr.reaction = 'Like' AND cpr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_like_count,
            SUM(IIF(cpr.reaction = 'Like' AND cpr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_like_count,
            SUM(IIF(cpr.reaction = 'Dislike', 1, 0)) AS dislike_count,
            SUM(IIF(cpr.reaction = 'Dislike' AND cpr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_dislike_count,
            SUM(IIF(cpr.reaction = 'Dislike' AND cpr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_dislike_count,
            SUM(IIF(cpr.reaction = 'Dislike' AND cpr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_dislike_count,
            SUM(IIF(cpr.reaction = 'Dislike' AND cpr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_dislike_count,
            SUM(IIF(cpr.reaction = 'Cry', 1, 0)) AS cry_count,
            SUM(IIF(cpr.reaction = 'Cry' AND cpr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cry_count,
            SUM(IIF(cpr.reaction = 'Cry' AND cpr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cry_count,
            SUM(IIF(cpr.reaction = 'Cry' AND cpr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cry_count,
            SUM(IIF(cpr.reaction = 'Cry' AND cpr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cry_count,
            SUM(IIF(cpr.reaction = 'Laugh', 1, 0)) AS laugh_count,
            SUM(IIF(cpr.reaction = 'Laugh' AND cpr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_laugh_count,
            SUM(IIF(cpr.reaction = 'Laugh' AND cpr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_laugh_count,
            SUM(IIF(cpr.reaction = 'Laugh' AND cpr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_laugh_count,
            SUM(IIF(cpr.reaction = 'Laugh' AND cpr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_laugh_count
          FROM "ClubPostReaction" cpr
          GROUP BY cpr."clubPostId"
        ) cpr ON cpr."clubPostId" = a.id
      ) m
      CROSS JOIN (
        SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
      ) tf
      ON CONFLICT ("clubPostId", timeframe) DO UPDATE
        SET "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount",  "cryCount" = EXCLUDED."cryCount", "heartCount" = EXCLUDED."heartCount";
    `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "ClubPostMetric" SET "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "heartCount" = 0  WHERE timeframe = 'Day';
    `;
  },
});

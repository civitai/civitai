import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const tempRecomputePostMetrics = createJob(
  'recompute-post-metrics',
  '13 1 * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('recompute-post-metrics');

    await dbWrite.$executeRaw`
    -- upsert metrics for all posts
    INSERT INTO "PostMetric" ("postId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount")
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
        WHEN tf.timeframe = 'AllTime' THEN heart_count
        WHEN tf.timeframe = 'Year' THEN year_heart_count
        WHEN tf.timeframe = 'Month' THEN month_heart_count
        WHEN tf.timeframe = 'Week' THEN week_heart_count
        WHEN tf.timeframe = 'Day' THEN day_heart_count
      END AS heart_count,
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
      END AS cry_count
    FROM
    (
      SELECT
        ir.id,
        COALESCE(ir.heart_count,0) AS heart_count,
        COALESCE(ir.year_heart_count,0) AS year_heart_count,
        COALESCE(ir.month_heart_count,0) AS month_heart_count,
        COALESCE(ir.week_heart_count,0) AS week_heart_count,
        COALESCE(ir.day_heart_count,0) AS day_heart_count,
        COALESCE(ir.laugh_count,0) AS laugh_count,
        COALESCE(ir.year_laugh_count,0) AS year_laugh_count,
        COALESCE(ir.month_laugh_count,0) AS month_laugh_count,
        COALESCE(ir.week_laugh_count,0) AS week_laugh_count,
        COALESCE(ir.day_laugh_count,0) AS day_laugh_count,
        COALESCE(ir.cry_count,0) AS cry_count,
        COALESCE(ir.year_cry_count,0) AS year_cry_count,
        COALESCE(ir.month_cry_count,0) AS month_cry_count,
        COALESCE(ir.week_cry_count,0) AS week_cry_count,
        COALESCE(ir.day_cry_count,0) AS day_cry_count,
        COALESCE(ir.dislike_count,0) AS dislike_count,
        COALESCE(ir.year_dislike_count,0) AS year_dislike_count,
        COALESCE(ir.month_dislike_count,0) AS month_dislike_count,
        COALESCE(ir.week_dislike_count,0) AS week_dislike_count,
        COALESCE(ir.day_dislike_count,0) AS day_dislike_count,
        COALESCE(ir.like_count,0) AS like_count,
        COALESCE(ir.year_like_count,0) AS year_like_count,
        COALESCE(ir.month_like_count,0) AS month_like_count,
        COALESCE(ir.week_like_count,0) AS week_like_count,
        COALESCE(ir.day_like_count,0) AS day_like_count
      FROM (
        SELECT
          i."postId" AS id,
          SUM(IIF(ir.reaction = 'Heart', 1, 0)) AS heart_count,
          SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
          SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
          SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
          SUM(IIF(ir.reaction = 'Heart' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count,
          SUM(IIF(ir.reaction = 'Like', 1, 0)) AS like_count,
          SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_like_count,
          SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_like_count,
          SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_like_count,
          SUM(IIF(ir.reaction = 'Like' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_like_count,
          SUM(IIF(ir.reaction = 'Dislike', 1, 0)) AS dislike_count,
          SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_dislike_count,
          SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_dislike_count,
          SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_dislike_count,
          SUM(IIF(ir.reaction = 'Dislike' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_dislike_count,
          SUM(IIF(ir.reaction = 'Cry', 1, 0)) AS cry_count,
          SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cry_count,
          SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cry_count,
          SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cry_count,
          SUM(IIF(ir.reaction = 'Cry' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cry_count,
          SUM(IIF(ir.reaction = 'Laugh', 1, 0)) AS laugh_count,
          SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_laugh_count,
          SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_laugh_count,
          SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_laugh_count,
          SUM(IIF(ir.reaction = 'Laugh' AND ir."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_laugh_count
        FROM "ImageReaction" ir
        JOIN "Image" i ON i.id = ir."imageId"
        WHERE i."postId" IS NOT NULL
        GROUP BY i."postId"
      ) ir
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("postId", timeframe) DO UPDATE
      SET "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount";
  `;

    await setLastRun();
  }
);

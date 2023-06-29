import { createMetricProcessor } from '~/server/metrics/base.metrics';

export const userMetrics = createMetricProcessor({
  name: 'User',
  async update({ db, lastUpdate }) {
    await db.$executeRaw`
    WITH recent_engagements AS
    (
      SELECT
        a."userId" AS user_id
      FROM "UserEngagement" a
      WHERE (a."createdAt" > ${lastUpdate})

      UNION

      SELECT
        a."targetUserId" AS user_id
      FROM "UserEngagement" a
      WHERE (a."createdAt" > ${lastUpdate})

      UNION

      SELECT
        "userId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON mv."modelId" = m.id
      WHERE (mv."createdAt" > ${lastUpdate} OR m."publishedAt" > ${lastUpdate})

      UNION

      SELECT
        "userId"
      FROM "ResourceReview" r
      WHERE (r."createdAt" > ${lastUpdate})

      UNION

      SELECT
        a2."userId"
      FROM "AnswerVote" ar
      JOIN "Answer" a2 ON a2.id = ar."answerId"
      WHERE (ar."createdAt" > ${lastUpdate})

      UNION

      SELECT
        "userId"
      FROM "Answer" ar
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'User'
    ),
    -- Get all affected users
    affected_users AS
    (
        SELECT DISTINCT
            r.user_id
        FROM recent_engagements r
        JOIN "User" u ON u.id = r.user_id
        WHERE r.user_id IS NOT NULL
    )

    -- upsert metrics for all affected users
    -- perform a one-pass table scan producing all metrics for all affected users
    INSERT INTO "UserMetric" ("userId", timeframe, "followingCount", "followerCount", "hiddenCount", "uploadCount", "reviewCount", "answerCount", "answerAcceptCount")
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
      END AS hidden_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN upload_count
        WHEN tf.timeframe = 'Year' THEN year_upload_count
        WHEN tf.timeframe = 'Month' THEN month_upload_count
        WHEN tf.timeframe = 'Week' THEN week_upload_count
        WHEN tf.timeframe = 'Day' THEN day_upload_count
      END AS upload_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN review_count
        WHEN tf.timeframe = 'Year' THEN year_review_count
        WHEN tf.timeframe = 'Month' THEN month_review_count
        WHEN tf.timeframe = 'Week' THEN week_review_count
        WHEN tf.timeframe = 'Day' THEN day_review_count
      END AS review_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN answer_count
        WHEN tf.timeframe = 'Year' THEN year_answer_count
        WHEN tf.timeframe = 'Month' THEN month_answer_count
        WHEN tf.timeframe = 'Week' THEN week_answer_count
        WHEN tf.timeframe = 'Day' THEN day_answer_count
      END AS answer_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN check_count
        WHEN tf.timeframe = 'Year' THEN year_check_count
        WHEN tf.timeframe = 'Month' THEN month_check_count
        WHEN tf.timeframe = 'Week' THEN week_check_count
        WHEN tf.timeframe = 'Day' THEN day_check_count
      END AS check_count
    FROM
    (
      SELECT
        a.user_id,
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
        COALESCE(ft.day_hidden_count, 0) AS day_hidden_count,
        COALESCE(u.upload_count, 0) AS upload_count,
        COALESCE(u.year_upload_count, 0) AS year_upload_count,
        COALESCE(u.month_upload_count, 0) AS month_upload_count,
        COALESCE(u.week_upload_count, 0) AS week_upload_count,
        COALESCE(u.day_upload_count, 0) AS day_upload_count,
        COALESCE(r.review_count, 0) AS review_count,
        COALESCE(r.year_review_count, 0) AS year_review_count,
        COALESCE(r.month_review_count, 0) AS month_review_count,
        COALESCE(r.week_review_count, 0) AS week_review_count,
        COALESCE(r.day_review_count, 0) AS day_review_count,
        COALESCE(ans.answer_count, 0) AS answer_count,
        COALESCE(ans.year_answer_count, 0) AS year_answer_count,
        COALESCE(ans.month_answer_count, 0) AS month_answer_count,
        COALESCE(ans.week_answer_count, 0) AS week_answer_count,
        COALESCE(ans.day_answer_count, 0) AS day_answer_count,
        COALESCE(ans.check_count, 0) AS check_count,
        COALESCE(ans.year_check_count, 0) AS year_check_count,
        COALESCE(ans.month_check_count, 0) AS month_check_count,
        COALESCE(ans.week_check_count, 0) AS week_check_count,
        COALESCE(ans.day_check_count, 0) AS day_check_count
      FROM affected_users a
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
      ) fs ON a.user_id = fs.user_id
      LEFT JOIN (
        SELECT
          ans."userId" AS user_id,
          COUNT(*) answer_count,
          SUM(IIF(ans."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_answer_count,
          SUM(IIF(ans."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_answer_count,
          SUM(IIF(ans."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_answer_count,
          SUM(IIF(ans."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_answer_count,
          SUM(ar."checkCountAllTime") check_count,
          SUM(ar."checkCountDay") day_check_count,
          SUM(ar."checkCountWeek") week_check_count,
          SUM(ar."checkCountMonth") month_check_count,
          SUM(ar."checkCountYear") year_check_count
        FROM "AnswerRank" ar
        JOIN "Answer" ans ON ans.id = ar."answerId"
        GROUP BY ans."userId"
      ) ans ON a.user_id = ans.user_id
      LEFT JOIN (
        SELECT
          m2."userId" user_id,
          COUNT(*) upload_count,
          SUM(IIF(mv."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_upload_count,
          SUM(IIF(mv."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_upload_count,
          SUM(IIF(mv."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_upload_count,
          SUM(IIF(mv."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_upload_count
        FROM "ModelVersion" mv
        JOIN "Model" m2 ON mv."modelId" = m2.id
        WHERE m2.status = 'Published'
        GROUP BY m2."userId"
      ) u ON u.user_id = a.user_id
      LEFT JOIN (
        SELECT
          rr."userId" user_id,
          COUNT(*) review_count,
          SUM(IIF(rr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_review_count,
          SUM(IIF(rr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_review_count,
          SUM(IIF(rr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_review_count,
          SUM(IIF(rr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_review_count
        FROM "ResourceReview" rr
        JOIN "Model" m on rr."modelId" = m.id
        WHERE m.status = 'Published'
        GROUP BY rr."userId"
      ) r ON r.user_id = a.user_id
      LEFT JOIN (
        SELECT
          ue."targetUserId" AS user_id,
          SUM(IIF(ue.type = 'Follow', 1, 0)) AS follower_count,
          SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_follower_count,
          SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0))  AS month_follower_count,
          SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0))   AS week_follower_count,
          SUM(IIF(ue.type = 'Follow' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0))   AS day_follower_count,
          SUM(IIF(ue.type = 'Hide', 1, 0)) AS hidden_count,
          SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '365 days'), 1, 0))   AS year_hidden_count,
          SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '30 days'), 1, 0))    AS month_hidden_count,
          SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '7 days'), 1, 0))     AS week_hidden_count,
          SUM(IIF(ue.type = 'Hide' AND ue."createdAt" >= (NOW() - interval '1 days'), 1, 0))     AS day_hidden_count
        FROM "UserEngagement" ue
        GROUP BY ue."targetUserId"
      ) ft ON a.user_id = ft.user_id
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("userId", timeframe) DO UPDATE
      SET "followerCount" = EXCLUDED."followerCount", "followingCount" = EXCLUDED."followingCount", "hiddenCount" = EXCLUDED."hiddenCount", "uploadCount" = EXCLUDED."uploadCount", "reviewCount" = EXCLUDED."reviewCount", "answerCount" = EXCLUDED."answerCount", "answerAcceptCount" = EXCLUDED."answerAcceptCount";
  `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "UserMetric" SET "followerCount" = 0, "followingCount" = 0, "hiddenCount" = 0, "uploadCount" = 0, "reviewCount" = 0, "answerCount" = 0, "answerAcceptCount" = 0 WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'UserRank',
    primaryKey: 'userId',
    indexes: ['leaderboardRank'],
    refreshInterval: 1000 * 60 * 60 * 24, // 24 hours
  },
});

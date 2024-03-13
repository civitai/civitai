import { createMetricProcessor } from '~/server/metrics/base.metrics';

export const answerMetrics = createMetricProcessor({
  name: 'Answer',
  async update({ db, lastUpdate }) {
    return;
    // Disabled for now

    await db.$executeRaw`
    WITH recent_engagements AS
    (
      SELECT
        "answerId" AS id
      FROM "AnswerReaction"
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT t."answerId" as id
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."answerId" IS NOT NULL
      AND c."createdAt" > ${lastUpdate}

      UNION

      SELECT
        "answerId" AS id
      FROM "AnswerVote"
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Answer'
    ),
    -- Get all affected users
    affected AS
    (
        SELECT DISTINCT
            r.id
        FROM recent_engagements r
        JOIN "Answer" a ON a.id = r.id
        WHERE r.id IS NOT NULL
    )

    -- upsert metrics for all affected users
    -- perform a one-pass table scan producing all metrics for all affected users
    INSERT INTO "AnswerMetric" ("answerId", timeframe, "heartCount", "checkCount", "crossCount", "commentCount")
    SELECT
      m.id,
      tf.timeframe,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN heart_count
        WHEN tf.timeframe = 'Year' THEN year_heart_count
        WHEN tf.timeframe = 'Month' THEN month_heart_count
        WHEN tf.timeframe = 'Week' THEN week_heart_count
        WHEN tf.timeframe = 'Day' THEN day_heart_count
      END AS heart_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN check_count
        WHEN tf.timeframe = 'Year' THEN year_check_count
        WHEN tf.timeframe = 'Month' THEN month_check_count
        WHEN tf.timeframe = 'Week' THEN week_check_count
        WHEN tf.timeframe = 'Day' THEN day_check_count
      END AS check_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN cross_count
        WHEN tf.timeframe = 'Year' THEN year_cross_count
        WHEN tf.timeframe = 'Month' THEN month_cross_count
        WHEN tf.timeframe = 'Week' THEN week_cross_count
        WHEN tf.timeframe = 'Day' THEN day_cross_count
      END AS cross_count,
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
        q.id,
        COALESCE(c.comment_count, 0) AS comment_count,
        COALESCE(c.year_comment_count, 0) AS year_comment_count,
        COALESCE(c.month_comment_count, 0) AS month_comment_count,
        COALESCE(c.week_comment_count, 0) AS week_comment_count,
        COALESCE(c.day_comment_count, 0) AS day_comment_count,
        COALESCE(r.heart_count, 0) AS heart_count,
        COALESCE(r.year_heart_count, 0) AS year_heart_count,
        COALESCE(r.month_heart_count, 0) AS month_heart_count,
        COALESCE(r.week_heart_count, 0) AS week_heart_count,
        COALESCE(r.day_heart_count, 0) AS day_heart_count,
        COALESCE(v.check_count, 0) AS check_count,
        COALESCE(v.year_check_count, 0) AS year_check_count,
        COALESCE(v.month_check_count, 0) AS month_check_count,
        COALESCE(v.week_check_count, 0) AS week_check_count,
        COALESCE(v.day_check_count, 0) AS day_check_count,
        COALESCE(v.cross_count, 0) AS cross_count,
        COALESCE(v.year_cross_count, 0) AS year_cross_count,
        COALESCE(v.month_cross_count, 0) AS month_cross_count,
        COALESCE(v.week_cross_count, 0) AS week_cross_count,
        COALESCE(v.day_cross_count, 0) AS day_cross_count
      FROM affected q
      LEFT JOIN (
        SELECT
          ac."answerId" AS id,
          COUNT(*) AS comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
        FROM "Thread" ac
        JOIN "CommentV2" v ON ac."id" = v."threadId"
        WHERE ac."answerId" IS NOT NULL
        GROUP BY ac."answerId"
      ) c ON q.id = c.id
      LEFT JOIN (
        SELECT
          av."answerId" AS id,
          COUNT(*) AS vote_count,
          SUM(IIF(av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_vote_count,
          SUM(IIF(av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_vote_count,
          SUM(IIF(av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_vote_count,
          SUM(IIF(av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_vote_count,
          SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS check_count,
          SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_check_count,
          SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_check_count,
          SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_check_count,
          SUM(IIF(av.vote = TRUE AND av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_check_count,
          SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS cross_count,
          SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_cross_count,
          SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_cross_count,
          SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_cross_count,
          SUM(IIF(av.vote = FALSE AND av."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_cross_count
        FROM "AnswerVote" av
        GROUP BY av."answerId"
      ) v ON v.id = q.id
      LEFT JOIN (
        SELECT
          ar."answerId" AS id,
          SUM(IIF(ar.reaction = 'Heart', 1, 0)) AS heart_count,
          SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
          SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
          SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
          SUM(IIF(ar.reaction = 'Heart' AND ar."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count
        FROM "AnswerReaction" ar
        GROUP BY ar."answerId"
      ) r ON q.id = r.id
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("answerId", timeframe) DO UPDATE
      SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "checkCount" = EXCLUDED."checkCount", "crossCount" = EXCLUDED."crossCount";
  `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "AnswerMetric" SET "heartCount" = 0, "checkCount" = 0, "crossCount" = 0, "commentCount" = 0 WHERE timeframe = 'Day';
    `;
  },
});

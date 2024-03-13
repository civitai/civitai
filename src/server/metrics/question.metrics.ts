import { createMetricProcessor } from '~/server/metrics/base.metrics';

export const questionMetrics = createMetricProcessor({
  name: 'Question',
  async update({ db, lastUpdate }) {
    return;
    // Disabled for now
    await db.$executeRaw`
    WITH recent_engagements AS
    (
      SELECT
        "questionId" AS id
      FROM "QuestionReaction"
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT
        a."questionId" AS id
      FROM "Answer" a
      WHERE (a."createdAt" > ${lastUpdate})

      UNION

      SELECT t."questionId" as id
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."questionId" IS NOT NULL AND c."createdAt" > ${lastUpdate}

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Question'
    ),
    -- Get all affected users
    affected AS
    (
        SELECT DISTINCT
            r.id
        FROM recent_engagements r
        JOIN "Question" q ON q.id = r.id
        WHERE r.id IS NOT NULL
    )

    -- upsert metrics for all affected users
    -- perform a one-pass table scan producing all metrics for all affected users
    INSERT INTO "QuestionMetric" ("questionId", timeframe, "heartCount", "commentCount", "answerCount")
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
        WHEN tf.timeframe = 'AllTime' THEN comment_count
        WHEN tf.timeframe = 'Year' THEN year_comment_count
        WHEN tf.timeframe = 'Month' THEN month_comment_count
        WHEN tf.timeframe = 'Week' THEN week_comment_count
        WHEN tf.timeframe = 'Day' THEN day_comment_count
      END AS comment_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN answer_count
        WHEN tf.timeframe = 'Year' THEN year_answer_count
        WHEN tf.timeframe = 'Month' THEN month_answer_count
        WHEN tf.timeframe = 'Week' THEN week_answer_count
        WHEN tf.timeframe = 'Day' THEN day_answer_count
      END AS answer_count
    FROM
    (
      SELECT
        q.id,
        COALESCE(r.heart_count, 0) AS heart_count,
        COALESCE(r.year_heart_count, 0) AS year_heart_count,
        COALESCE(r.month_heart_count, 0) AS month_heart_count,
        COALESCE(r.week_heart_count, 0) AS week_heart_count,
        COALESCE(r.day_heart_count, 0) AS day_heart_count,
        COALESCE(c.comment_count, 0) AS comment_count,
        COALESCE(c.year_comment_count, 0) AS year_comment_count,
        COALESCE(c.month_comment_count, 0) AS month_comment_count,
        COALESCE(c.week_comment_count, 0) AS week_comment_count,
        COALESCE(c.day_comment_count, 0) AS day_comment_count,
        COALESCE(a.answer_count, 0) AS answer_count,
        COALESCE(a.year_answer_count, 0) AS year_answer_count,
        COALESCE(a.month_answer_count, 0) AS month_answer_count,
        COALESCE(a.week_answer_count, 0) AS week_answer_count,
        COALESCE(a.day_answer_count, 0) AS day_answer_count
      FROM affected q
      LEFT JOIN (
        SELECT
          a."questionId" AS id,
          COUNT(*) AS answer_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_answer_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_answer_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_answer_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_answer_count
        FROM "Answer" a
        GROUP BY a."questionId"
      ) a ON q.id = a.id
      LEFT JOIN (
        SELECT
          qc."questionId" AS id,
          COUNT(*) AS comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
        FROM "Thread" qc
        JOIN "CommentV2" v ON qc."id" = v."threadId"
        WHERE qc."questionId" IS NOT NULL
        GROUP BY qc."questionId"
      ) c ON q.id = c.id
      LEFT JOIN (
        SELECT
          qr."questionId" AS id,
          SUM(IIF(qr.reaction = 'Heart', 1, 0)) AS heart_count,
          SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_heart_count,
          SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_heart_count,
          SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_heart_count,
          SUM(IIF(qr.reaction = 'Heart' AND qr."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_heart_count
        FROM "QuestionReaction" qr
        GROUP BY qr."questionId"
      ) r ON q.id = r.id
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("questionId", timeframe) DO UPDATE
      SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "answerCount" = EXCLUDED."answerCount";
  `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
    UPDATE "QuestionMetric" SET "answerCount" = 0, "commentCount" = 0, "heartCount" = 0 WHERE timeframe = 'Day';
  `;
  },
});

import { chunk } from 'lodash';
import { createMetricProcessor } from '~/server/metrics/base.metrics';

export const articleMetrics = createMetricProcessor({
  name: 'Article',
  async update({ db, ch, lastUpdate }) {
    // --------------------------------------------
    // Update Article Views from ClickHouse
    // --------------------------------------------
    const viewedArticlesResponse = await ch.query({
      query: `
        WITH affected AS
        (
            SELECT DISTINCT entityId
            FROM uniqueViews
            WHERE type = 'ArticleView'
            AND time >= parseDateTimeBestEffortOrNull('${lastUpdate}')
        )
        SELECT
            uv.entityId as entityId,
            SUM(if(uv.time >= subtractDays(now(), 1), 1, null)) AS viewsDay,
            SUM(if(uv.time >= subtractDays(now(), 7), 1, null)) AS viewsWeek,
            SUM(if(uv.time >= subtractMonths(now(), 1), 1, null)) AS viewsMonth,
            SUM(if(uv.time >= subtractYears(now(), 1), 1, null)) AS viewsYear,
            COUNT() AS viewsAll
        FROM affected a
        JOIN uniqueViews uv ON a.entityId = uv.entityId
        GROUP BY uv.entityId
      `,
      format: 'JSONEachRow',
    });

    const viewedArticles = (await viewedArticlesResponse?.json()) as ArticleViews[];

    // We batch the affected articles up when sending it to the db
    const batchSize = 500;
    const batches = chunk(viewedArticles, batchSize);
    for (const batch of batches) {
      const batchJson = JSON.stringify(batch);

      await db.$executeRaw`
      INSERT INTO "ArticleMetric" ("articleId", timeframe, "viewCount")
      SELECT
          a.entityId, a.timeframe, a.views
      FROM
      (
          SELECT
              CAST(js::json->>'entityId' AS INT) AS entityId,
              tf.timeframe,
              CAST(
                CASE
                  WHEN tf.timeframe = 'Day' THEN js::json->>'viewsDay'
                  WHEN tf.timeframe = 'Week' THEN js::json->>'viewsWeek'
                  WHEN tf.timeframe = 'Month' THEN js::json->>'viewsMonth'
                  WHEN tf.timeframe = 'Year' THEN js::json->>'viewsYear'
                  WHEN tf.timeframe = 'AllTime' THEN js::json->>'viewsAll'
                END
              AS int) as views
          FROM json_array_elements(${batchJson}::json) js
          CROSS JOIN (
              SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
          ) tf
      ) a
      WHERE
        a.views IS NOT NULL
        AND a.entityId IN (SELECT id FROM "Article")
      ON CONFLICT ("articleId", timeframe) DO UPDATE
        SET "viewCount" = EXCLUDED."viewCount";
    `;
    }

    // --------------------------------------------
    // Update Other Metrics from DB
    // --------------------------------------------

    await db.$executeRaw`
    WITH recent_engagements AS
    (
      SELECT
        "articleId" AS id
      FROM "ArticleReaction"
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT t."articleId" as id
      FROM "Thread" t
      JOIN "CommentV2" c ON c."threadId" = t.id
      WHERE t."articleId" IS NOT NULL AND c."createdAt" > ${lastUpdate}

      UNION

      SELECT
        "articleId"
      FROM "ArticleEngagement"
      WHERE "createdAt" > ${lastUpdate}

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Article'
    ),
    -- Get all affected
    affected AS
    (
        SELECT DISTINCT
            r.id
        FROM recent_engagements r
        JOIN "Article" a ON a.id = r.id
        WHERE r.id IS NOT NULL
    )

    -- upsert metrics for all affected
    -- perform a one-pass table scan producing all metrics for all affected
    INSERT INTO "ArticleMetric" ("articleId", timeframe, "likeCount", "dislikeCount", "heartCount", "laughCount", "cryCount", "commentCount", "favoriteCount", "hideCount")
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
      END AS cry_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN comment_count
        WHEN tf.timeframe = 'Year' THEN year_comment_count
        WHEN tf.timeframe = 'Month' THEN month_comment_count
        WHEN tf.timeframe = 'Week' THEN week_comment_count
        WHEN tf.timeframe = 'Day' THEN day_comment_count
      END AS comment_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN favorite_count
        WHEN tf.timeframe = 'Year' THEN year_favorite_count
        WHEN tf.timeframe = 'Month' THEN month_favorite_count
        WHEN tf.timeframe = 'Week' THEN week_favorite_count
        WHEN tf.timeframe = 'Day' THEN day_favorite_count
      END AS favorite_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN hide_count
        WHEN tf.timeframe = 'Year' THEN year_hide_count
        WHEN tf.timeframe = 'Month' THEN month_hide_count
        WHEN tf.timeframe = 'Week' THEN week_hide_count
        WHEN tf.timeframe = 'Day' THEN day_hide_count
      END AS hide_count
    FROM
    (
      SELECT
        q.id,
        COALESCE(r.heart_count, 0) AS heart_count,
        COALESCE(r.year_heart_count, 0) AS year_heart_count,
        COALESCE(r.month_heart_count, 0) AS month_heart_count,
        COALESCE(r.week_heart_count, 0) AS week_heart_count,
        COALESCE(r.day_heart_count, 0) AS day_heart_count,
        COALESCE(r.laugh_count, 0) AS laugh_count,
        COALESCE(r.year_laugh_count, 0) AS year_laugh_count,
        COALESCE(r.month_laugh_count, 0) AS month_laugh_count,
        COALESCE(r.week_laugh_count, 0) AS week_laugh_count,
        COALESCE(r.day_laugh_count, 0) AS day_laugh_count,
        COALESCE(r.cry_count, 0) AS cry_count,
        COALESCE(r.year_cry_count, 0) AS year_cry_count,
        COALESCE(r.month_cry_count, 0) AS month_cry_count,
        COALESCE(r.week_cry_count, 0) AS week_cry_count,
        COALESCE(r.day_cry_count, 0) AS day_cry_count,
        COALESCE(r.dislike_count, 0) AS dislike_count,
        COALESCE(r.year_dislike_count, 0) AS year_dislike_count,
        COALESCE(r.month_dislike_count, 0) AS month_dislike_count,
        COALESCE(r.week_dislike_count, 0) AS week_dislike_count,
        COALESCE(r.day_dislike_count, 0) AS day_dislike_count,
        COALESCE(r.like_count, 0) AS like_count,
        COALESCE(r.year_like_count, 0) AS year_like_count,
        COALESCE(r.month_like_count, 0) AS month_like_count,
        COALESCE(r.week_like_count, 0) AS week_like_count,
        COALESCE(r.day_like_count, 0) AS day_like_count,
        COALESCE(c.comment_count, 0) AS comment_count,
        COALESCE(c.year_comment_count, 0) AS year_comment_count,
        COALESCE(c.month_comment_count, 0) AS month_comment_count,
        COALESCE(c.week_comment_count, 0) AS week_comment_count,
        COALESCE(c.day_comment_count, 0) AS day_comment_count,
        COALESCE(ae.favorite_count, 0) AS favorite_count,
        COALESCE(ae.year_favorite_count, 0) AS year_favorite_count,
        COALESCE(ae.month_favorite_count, 0) AS month_favorite_count,
        COALESCE(ae.week_favorite_count, 0) AS week_favorite_count,
        COALESCE(ae.day_favorite_count, 0) AS day_favorite_count,
        COALESCE(ae.hide_count, 0) AS hide_count,
        COALESCE(ae.year_hide_count, 0) AS year_hide_count,
        COALESCE(ae.month_hide_count, 0) AS month_hide_count,
        COALESCE(ae.week_hide_count, 0) AS week_hide_count,
        COALESCE(ae.day_hide_count, 0) AS day_hide_count
      FROM affected q
      LEFT JOIN (
        SELECT
          ic."articleId" AS id,
          COUNT(*) AS comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_comment_count,
          SUM(IIF(v."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_comment_count
        FROM "Thread" ic
        JOIN "CommentV2" v ON ic."id" = v."threadId"
        WHERE ic."articleId" IS NOT NULL
        GROUP BY ic."articleId"
      ) c ON q.id = c.id
      LEFT JOIN (
        SELECT
          "articleId" AS id,
          SUM(IIF(type = 'Favorite', 1, 0)) AS favorite_count,
          SUM(IIF(type = 'Favorite' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_favorite_count,
          SUM(IIF(type = 'Favorite' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_favorite_count,
          SUM(IIF(type = 'Favorite' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_favorite_count,
          SUM(IIF(type = 'Favorite' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_favorite_count,
          SUM(IIF(type = 'Hide', 1, 0)) AS hide_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_hide_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_hide_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_hide_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_hide_count
        FROM "ArticleEngagement"
        GROUP BY "articleId"
      ) ae ON q.id = ae.id
      LEFT JOIN (
        SELECT
          ir."articleId" AS id,
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
        FROM "ArticleReaction" ir
        GROUP BY ir."articleId"
      ) r ON q.id = r.id
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("articleId", timeframe) DO UPDATE
      SET "commentCount" = EXCLUDED."commentCount", "heartCount" = EXCLUDED."heartCount", "likeCount" = EXCLUDED."likeCount", "dislikeCount" = EXCLUDED."dislikeCount", "laughCount" = EXCLUDED."laughCount", "cryCount" = EXCLUDED."cryCount", "favoriteCount" = EXCLUDED."favoriteCount", "hideCount" = EXCLUDED."hideCount";
  `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "ArticleMetric" SET "heartCount" = 0, "likeCount" = 0, "dislikeCount" = 0, "laughCount" = 0, "cryCount" = 0, "commentCount" = 0, "viewCount" = 0 WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'ArticleRank',
    primaryKey: 'articleId',
    indexes: ['reactionCountMonthRank'],
  },
});

type ArticleViews = {
  entityId: number;
  viewsDay: string;
  viewsWeek: string;
  viewsMonth: string;
  viewsYear: string;
  viewsAll: string;
};

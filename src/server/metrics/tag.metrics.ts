import { createMetricProcessor } from '~/server/metrics/base.metrics';

export const tagMetrics = createMetricProcessor({
  name: 'Tag',
  async update({ db, lastUpdate }) {
    await db.$executeRaw`
    -- Get all engagements that have happened since then that affect metrics
    WITH recent_engagements AS
    (
      SELECT
        "tagId" AS id
      FROM "Model" m
      JOIN "TagsOnModels" tom ON tom."modelId" = m.id
      WHERE (m."updatedAt" > ${lastUpdate})

      UNION

      SELECT
        "tagId" AS id
      FROM "TagEngagement"
      WHERE ("createdAt" > ${lastUpdate})

      UNION

      SELECT
        "tagId" AS id
      FROM "Image" i
      JOIN "TagsOnImage" toi ON toi."imageId" = i.id
      WHERE (i."createdAt" > ${lastUpdate})

      UNION

      SELECT
        "id"
      FROM "MetricUpdateQueue"
      WHERE type = 'Tag'
    ),
    -- Get all affected
    affected AS
    (
        SELECT DISTINCT
            r.id
        FROM recent_engagements r
        JOIN "Tag" t ON t.id = r.id
        WHERE r.id IS NOT NULL
    )

    -- upsert metrics for all affected
    -- perform a one-pass table scan producing all metrics for all affected users
    INSERT INTO "TagMetric" ("tagId", timeframe, "followerCount", "hiddenCount", "modelCount", "imageCount", "postCount", "articleCount")
    SELECT
      m.id,
      tf.timeframe,
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
        WHEN tf.timeframe = 'AllTime' THEN model_count
        WHEN tf.timeframe = 'Year' THEN year_model_count
        WHEN tf.timeframe = 'Month' THEN month_model_count
        WHEN tf.timeframe = 'Week' THEN week_model_count
        WHEN tf.timeframe = 'Day' THEN day_model_count
      END AS model_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN image_count
        WHEN tf.timeframe = 'Year' THEN year_image_count
        WHEN tf.timeframe = 'Month' THEN month_image_count
        WHEN tf.timeframe = 'Week' THEN week_image_count
        WHEN tf.timeframe = 'Day' THEN day_image_count
      END AS image_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN post_count
        WHEN tf.timeframe = 'Year' THEN year_post_count
        WHEN tf.timeframe = 'Month' THEN month_post_count
        WHEN tf.timeframe = 'Week' THEN week_post_count
        WHEN tf.timeframe = 'Day' THEN day_post_count
      END AS post_count,
      CASE
        WHEN tf.timeframe = 'AllTime' THEN article_count
        WHEN tf.timeframe = 'Year' THEN year_article_count
        WHEN tf.timeframe = 'Month' THEN month_article_count
        WHEN tf.timeframe = 'Week' THEN week_article_count
        WHEN tf.timeframe = 'Day' THEN day_article_count
      END AS article_count
    FROM
    (
      SELECT
        a.id,
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
        COALESCE(r.model_count, 0) AS model_count,
        COALESCE(r.year_model_count, 0) AS year_model_count,
        COALESCE(r.month_model_count, 0) AS month_model_count,
        COALESCE(r.week_model_count, 0) AS week_model_count,
        COALESCE(r.day_model_count, 0) AS day_model_count,
        COALESCE(i.image_count, 0) AS image_count,
        COALESCE(i.year_image_count, 0) AS year_image_count,
        COALESCE(i.month_image_count, 0) AS month_image_count,
        COALESCE(i.week_image_count, 0) AS week_image_count,
        COALESCE(i.day_image_count, 0) AS day_image_count,
        COALESCE(p.post_count, 0) AS post_count,
        COALESCE(p.year_post_count, 0) AS year_post_count,
        COALESCE(p.month_post_count, 0) AS month_post_count,
        COALESCE(p.week_post_count, 0) AS week_post_count,
        COALESCE(p.day_post_count, 0) AS day_post_count,
        COALESCE(art.article_count, 0) AS article_count,
        COALESCE(art.year_article_count, 0) AS year_article_count,
        COALESCE(art.month_article_count, 0) AS month_article_count,
        COALESCE(art.week_article_count, 0) AS week_article_count,
        COALESCE(art.day_article_count, 0) AS day_article_count
      FROM affected a
      LEFT JOIN (
        SELECT
          "tagId" id,
          COUNT("modelId") model_count,
          SUM(IIF(m."publishedAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_model_count,
          SUM(IIF(m."publishedAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_model_count,
          SUM(IIF(m."publishedAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_model_count,
          SUM(IIF(m."publishedAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_model_count
        FROM "TagsOnModels" tom
        JOIN "Model" m ON m.id = tom."modelId"
        GROUP BY "tagId"
      ) r ON r.id = a.id
      LEFT JOIN (
        SELECT
          "tagId" id,
          COUNT("imageId") image_count,
          SUM(IIF(i."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_image_count,
          SUM(IIF(i."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_image_count,
          SUM(IIF(i."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_image_count,
          SUM(IIF(i."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_image_count
        FROM "TagsOnImage" toi
        JOIN "Image" i ON i.id = toi."imageId"
        GROUP BY "tagId"
      ) i ON i.id = a.id
      LEFT JOIN (
        SELECT
          "tagId" id,
          COUNT("postId") post_count,
          SUM(IIF(p."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_post_count,
          SUM(IIF(p."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_post_count,
          SUM(IIF(p."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_post_count,
          SUM(IIF(p."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_post_count
        FROM "TagsOnPost" top
        JOIN "Post" p ON p.id = top."postId"
        GROUP BY "tagId"
      ) p ON p.id = a.id
      LEFT JOIN (
        SELECT
          "tagId" id,
          COUNT("articleId") article_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_article_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '30 days'), 1, 0)) AS month_article_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '7 days'), 1, 0)) AS week_article_count,
          SUM(IIF(a."createdAt" >= (NOW() - interval '1 days'), 1, 0)) AS day_article_count
        FROM "TagsOnArticle" toa
        JOIN "Article" a ON a.id = toa."articleId"
        GROUP BY "tagId"
      ) art ON art.id = a.id
      LEFT JOIN (
        SELECT
          "tagId"                                                                      AS id,
          SUM(IIF(type = 'Follow', 1, 0))                                                     AS follower_count,
          SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0)) AS year_follower_count,
          SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0))  AS month_follower_count,
          SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0))   AS week_follower_count,
          SUM(IIF(type = 'Follow' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0))   AS day_follower_count,
          SUM(IIF(type = 'Hide', 1, 0))                                                       AS hidden_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '365 days'), 1, 0))   AS year_hidden_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '30 days'), 1, 0))    AS month_hidden_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '7 days'), 1, 0))     AS week_hidden_count,
          SUM(IIF(type = 'Hide' AND "createdAt" >= (NOW() - interval '1 days'), 1, 0))     AS day_hidden_count
        FROM "TagEngagement"
        GROUP BY "tagId"
      ) ft ON a.id = ft.id
    ) m
    CROSS JOIN (
      SELECT unnest(enum_range(NULL::"MetricTimeframe")) AS timeframe
    ) tf
    ON CONFLICT ("tagId", timeframe) DO UPDATE
      SET "followerCount" = EXCLUDED."followerCount", "modelCount" = EXCLUDED."modelCount", "hiddenCount" = EXCLUDED."hiddenCount", "postCount" = EXCLUDED."postCount", "imageCount" = EXCLUDED."imageCount", "articleCount" = EXCLUDED."articleCount";
  `;
  },
  async clearDay({ db }) {
    await db.$executeRaw`
      UPDATE "TagMetric" SET "followerCount" = 0, "modelCount" = 0, "hiddenCount" = 0, "postCount" = 0, "imageCount" = 0, "articleCount" = 0 WHERE timeframe = 'Day';
    `;
  },
  rank: {
    table: 'TagRank',
    primaryKey: 'tagId',
    refreshInterval: 5 * 60 * 1000,
  },
});

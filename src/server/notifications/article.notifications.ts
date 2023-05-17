import { clickhouse } from '~/server/clickhouse/client';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const articleViewMilestones = [100, 500, 1000, 10000, 50000, 100000, 500000, 1000000] as const;
const articleLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const articleNotifications = createNotificationProcessor({
  'article-view-milestone': {
    displayName: 'Article view milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${details.articleTitle}" has received ${details.viewCount} views`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: async ({ lastSent }) => {
      const affected = (await clickhouse
        ?.query({
          query: `
            SELECT DISTINCT entityId
            FROM views
            WHERE time > parseDateTimeBestEffortOrNull('${lastSent}')
            AND entityType = 'Article'
        `,
          format: 'JSONEachRow',
        })
        .then((x) => x.json())) as [{ entityId: number }];

      const affectedJson = JSON.stringify(affected.map((x) => x.entityId));

      return `
        WITH milestones AS (
          SELECT * FROM (VALUES ${articleViewMilestones.map((x) => `(${x})`).join(', ')}) m(value)
        ), val AS (
          SELECT
            "articleId" article_id,
            "viewCount" view_count
          FROM "ArticleMetric" am
          WHERE
            am."articleId" = ANY (SELECT json_array_elements('${affectedJson}'::json)::text::integer)
            AND "viewCount" > ${articleViewMilestones[0]}
            AND timeframe = 'AllTime'
        ), prior_milestones AS (
          SELECT DISTINCT
            article_id,
            cast(details->'viewCount' as int) as view_count
          FROM "Notification"
          JOIN val ON article_id = cast(details->'articleId' as int)
          WHERE type = 'article-view-milestone'
        ), milestone AS (
          SELECT
            a."userId" "ownerId",
            JSON_BUILD_OBJECT(
              'articleTitle', a.title,
              'articleId', a.id,
              'viewCount', ms.value
            ) "details"
          FROM val
          JOIN "Article" a on a.id = val.article_id
          JOIN milestones ms ON ms.value <= val.view_count
          LEFT JOIN prior_milestones pm ON pm.view_count >= ms.value AND pm.article_id = val.article_id
          WHERE pm.article_id IS NULL
        )
        INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          REPLACE(gen_random_uuid()::text, '-', ''),
          "ownerId"    "userId",
          'article-view-milestone' "type",
          details
        FROM milestone
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-view-milestone');
      `;
    },
  },
  'article-like-milestone': {
    displayName: 'Article like milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${details.articleTitle}" has received ${details.favoriteCount} likes`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${articleLikeMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "articleId" article_id
        FROM "ArticleEngagement" ae
        JOIN "Article" a ON ae."articleId" = a.id
        WHERE ae."createdAt" > '${lastSent}' AND ae.type = 'Favorite'
        AND a."userId" > 0
      ), val AS (
        SELECT
          article_id,
          "favoriteCount" favorite_count
        FROM "ArticleMetric" am
        JOIN affected am ON am.article_id = am."articleId"
        WHERE
          timeframe = 'AllTime'
          AND "favoriteCount" > ${articleLikeMilestones[0]}
      ), prior_milestones AS (
        SELECT DISTINCT
          article_id,
          cast(details->'favoriteCount' as int) favorite_count
        FROM "Notification"
        JOIN affected ON article_id = cast(details->'articleId' as int)
        WHERE type = 'article-like-milestone'
      ), milestone AS (
        SELECT
          a."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'articleTitle', a.title,
            'articleId', a.id,
            'favoriteCount', ms.value
          ) "details"
        FROM val
        JOIN "Article" a on a.id = val.article_id
        JOIN milestones ms ON ms.value <= val.favorite_count
        LEFT JOIN prior_milestones pm ON pm.favorite_count >= ms.value AND pm.article_id = val.article_id
        WHERE pm.article_id IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'article-like-milestone' "type",
        details
      FROM milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-like-milestone');
    `,
  },
  'new-article-from-following': {
    displayName: 'New articles from followed users',
    prepareMessage: ({ details }) => ({
      message: `${details.username} published a new ${details.articleCategory}: "${details.articleTitle}"`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH article_categories AS (
        SELECT
          t.id,
          t.name
        FROM "Tag" t
        JOIN "TagsOnTags" tt ON tt."toTagId" = t.id
        JOIN "Tag" f ON f.id = tt."fromTagId"
        WHERE f.name = 'article category'
      ), new_article AS (
        SELECT DISTINCT
          ue."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'articleId', a.id,
            'articleTitle', a.title,
            'username', u.username,
            'articleCategory', ac.name
          ) "details"
        FROM "Article" a
        JOIN (
          SELECT
            toa."articleId",
            ac.name,
            row_number() OVER (PARTITION BY toa."articleId") row
          FROM article_categories ac
          JOIN "TagsOnArticle" toa ON toa."tagId" = ac.id
        ) ac ON ac."articleId" = a.id AND ac.row = 1
        JOIN "User" u ON u.id = a."userId"
        JOIN "UserEngagement" ue ON ue."targetUserId" = a."userId" AND a."publishedAt" >= ue."createdAt" AND ue.type = 'Follow'
        WHERE a."publishedAt" > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-article-from-following' "type",
        details
      FROM new_article
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-article-from-following');
    `,
  },
});

import { milestoneNotificationFix } from '~/server/common/constants';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const articleViewMilestones = [100, 500, 1000, 10000, 50000, 100000, 500000, 1000000] as const;
const articleLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const articleNotifications = createNotificationProcessor({
  'article-view-milestone': {
    displayName: 'Article view milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${
        details.articleTitle
      }" has received ${details.viewCount.toLocaleString()} views`,
      url: `/articles/${details.articleId}`,
    }),
    category: 'Milestone',
    prepareQuery: async ({ lastSent, clickhouse, category }) => {
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
            AND "viewCount" >= ${articleViewMilestones[0]}
            AND timeframe = 'AllTime'
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
          WHERE a."createdAt" > '${milestoneNotificationFix}'
        )
        INSERT INTO "Notification"("id", "userId", "type", "details", "category")
        SELECT
          CONCAT('milestone:article-view:', details->>'articleId', ':', details->>'viewCount'),
          "ownerId"    "userId",
          'article-view-milestone' "type",
          details,
          '${category}'::"NotificationCategory" "category"
        FROM milestone
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-view-milestone')
        ON CONFLICT (id) DO NOTHING;
      `;
    },
  },
  'article-like-milestone': {
    displayName: 'Article like milestones',
    category: 'Milestone',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${
        details.articleTitle
      }" has received ${details.favoriteCount.toLocaleString()} likes`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${articleLikeMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "articleId" article_id
        FROM "CollectionItem" ci
        JOIN "Collection" c ON ci."collectionId" = c.id AND c."type" = 'Article' AND c."mode" = 'Bookmark'
        JOIN "Article" a ON ci."articleId" = a.id
        WHERE ci."createdAt" > '${lastSent}'
          AND a."userId" > 0
      ), val AS (
        SELECT
          article_id,
          "favoriteCount" favorite_count
        FROM "ArticleMetric" am
        JOIN affected af ON af.article_id = am."articleId"
        WHERE
          timeframe = 'AllTime'
          AND "favoriteCount" >= ${articleLikeMilestones[0]}
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
        WHERE a."createdAt" > '${milestoneNotificationFix}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT('milestone:article-like:', details->>'articleId', ':', details->>'favoriteCount'),
        "ownerId"    "userId",
        'article-like-milestone' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-like-milestone')
      ON CONFLICT (id) DO NOTHING;
    `,
  },
  'new-article-from-following': {
    displayName: 'New articles from followed users',
    category: 'Update',
    prepareMessage: ({ details }) => ({
      message: `${details.username} published a new ${details.articleCategory}: "${details.articleTitle}"`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-article-from-following' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_article
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-article-from-following');
    `,
  },
});

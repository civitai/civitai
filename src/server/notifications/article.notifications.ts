import { milestoneNotificationFix } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';

const articleViewMilestones = [100, 500, 1000, 10000, 50000, 100000, 500000, 1000000] as const;
const articleLikeMilestones = [100, 500, 1000, 10000, 50000] as const;

export const NEW_ARTICLE_FROM_FOLLOWING_TYPE = 'new-article-from-following';

/**
 * How far behind its cursor each run re-reads. `publishedAt` is stamped by the app before the row
 * commits, and the job takes its next cursor before querying the replica, so an article stamped just
 * before a run but not yet visible to it would otherwise fall behind the cursor for good. Re-reading
 * is safe: the key is per article and the notifications worker skips a recipient who already has it.
 */
const PUBLISHED_LOOKBACK = '5 minutes';

export function newArticleFromFollowingMessage(details: {
  username?: string;
  articleCategory?: string | null;
  articleTitle?: string;
}) {
  const kind = details.articleCategory ? `new ${details.articleCategory} article` : 'new article';
  return `${details.username} published a ${kind}: "${details.articleTitle}"`;
}

export function newArticleFromFollowingQuery({ lastSent }: { lastSent: string }) {
  return `
      WITH new_article AS (
        SELECT DISTINCT
          ue."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'articleId', a.id,
            'articleTitle', a.title,
            'username', u.username,
            'articleCategory', ac.name
          ) "details"
        FROM "Article" a
        -- LEFT: an article published before its author picks a category still reaches followers,
        -- and adding the category later cannot, because the cursor has already passed it.
        LEFT JOIN LATERAL (
          SELECT t.name
          FROM "TagsOnArticle" toa
          JOIN "Tag" t ON t.id = toa."tagId"
          WHERE toa."articleId" = a.id
            AND EXISTS (
              SELECT 1
              FROM "TagsOnTags" tt
              JOIN "Tag" f ON f.id = tt."fromTagId"
              WHERE tt."toTagId" = t.id AND f.name = 'article category'
            )
          ORDER BY t.name
          LIMIT 1
        ) ac ON true
        JOIN "User" u ON u.id = a."userId"
        JOIN "UserEngagement" ue ON ue."targetUserId" = a."userId" AND a."publishedAt" >= ue."createdAt" AND ue.type = 'Follow'
        WHERE a."publishedAt" > '${lastSent}'::timestamp - INTERVAL '${PUBLISHED_LOOKBACK}'
          AND a."publishedAt" <= now()
          AND a.status = 'Published'
          AND NOT a."tosViolation"
          AND u."bannedAt" IS NULL
          AND NOT u.muted
          AND ${notBlockedBetween('ue."userId"', 'a."userId"')}
      )
      SELECT
        CONCAT('${NEW_ARTICLE_FROM_FOLLOWING_TYPE}:', details->>'articleId') "key",
        "ownerId"    "userId",
        '${NEW_ARTICLE_FROM_FOLLOWING_TYPE}' "type",
        details
      FROM new_article
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = '${NEW_ARTICLE_FROM_FOLLOWING_TYPE}')
    `;
}

export const articleNotifications = createNotificationProcessor({
  'article-view-milestone': {
    displayName: 'Article view milestones',
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${
        details.articleTitle
      }" has received ${details.viewCount.toLocaleString()} views`,
      url: `/articles/${details.articleId}`,
    }),
    category: NotificationCategory.Milestone,
    prepareQuery: async ({ lastSentDate, clickhouse }) => {
      if (!clickhouse) return;
      const affected = await clickhouse.$query<{ entityId: number }>`
        SELECT DISTINCT entityId
        FROM views
        WHERE time > ${lastSentDate}
        AND entityType = 'Article'
      `;

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
        SELECT
          CONCAT('article-view-milestone:', details->>'articleId', ':', details->>'viewCount') "key",
          "ownerId"    "userId",
          'article-view-milestone' "type",
          details
        FROM milestone
        WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-view-milestone')
      `;
    },
  },
  'article-like-milestone': {
    displayName: 'Article like milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => ({
      message: `Congrats! Your article, "${
        details.articleTitle
      }" has received ${details.favoriteCount.toLocaleString()} likes`,
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: ({ lastSent }) => `
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
      SELECT
        CONCAT('article-like-milestone:', details->>'articleId', ':', details->>'favoriteCount') "key",
        "ownerId"    "userId",
        'article-like-milestone' "type",
        details
      FROM milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-like-milestone')
    `,
  },
  // Moveable
  [NEW_ARTICLE_FROM_FOLLOWING_TYPE]: {
    displayName: 'New articles from followed users',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: newArticleFromFollowingMessage(details),
      url: `/articles/${details.articleId}`,
    }),
    prepareQuery: newArticleFromFollowingQuery,
  },
});

import { milestoneNotificationFix } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { humanizeList } from '~/utils/humanizer';

const commentReactionMilestones = [5, 10, 20, 50, 100] as const;
export const imageReactionMilestones = [5, 10, 20, 50, 100] as const;
const articleReactionMilestones = [5, 10, 20, 50, 100] as const;
// const reviewReactionMilestones = [5, 10, 20, 50, 100] as const;

export const reactionNotifications = createNotificationProcessor({
  'comment-reaction-milestone': {
    displayName: 'Comment reaction milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => ({
      message: `Your comment on ${details.modelName} has received ${details.reactionCount} reactions`,
      url: `/models/${details.modelId}?dialog=commentThread&commentId=${details.rootCommentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${commentReactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "commentId" affected_id
        FROM "CommentReaction"
        WHERE "createdAt" > '${lastSent}'
      ), affected_value AS (
        SELECT
          a.affected_id,
          COUNT(r."commentId") reaction_count
        FROM "CommentReaction" r
        JOIN affected a ON a.affected_id = r."commentId"
        GROUP BY a.affected_id
        HAVING COUNT(*) >= ${commentReactionMilestones[0]}
      ), reaction_milestone AS (
        SELECT
          c."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'modelName', m.name,
            'modelId', m.id,
            'rootCommentId', COALESCE(c."parentId", c.id),
            'commentId', c.id,
            'reactionCount', ms.value
          ) "details"
        FROM affected_value a
        JOIN "Comment" c on c.id = a.affected_id
        JOIN "Model" m ON m.id = c."modelId"
        JOIN milestones ms ON ms.value <= a.reaction_count
        WHERE c."createdAt" > '${milestoneNotificationFix}'
      )
      SELECT
        CONCAT('comment-reaction-milestone:', details->>'commentId', ':', details->>'reactionCount') "key",
        "ownerId"    "userId",
        'comment-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'comment-reaction-milestone')
    `,
  },
  'image-reaction-milestone': {
    displayName: 'Image reaction milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => {
      let message: string;
      if (details.version === 2) {
        let modelList: string | undefined;
        if (details.models) {
          const displayModels = details.models.slice(0, 2);
          const additionalModels = details.models.length - displayModels.length;
          modelList =
            additionalModels > 0
              ? displayModels.join(', ') + `, and ${additionalModels} more`
              : humanizeList(displayModels);
        }

        message = `Your image${modelList ? ` using ${modelList}` : ''} has received ${
          details.reactionCount
        } reactions`;
      } else {
        message = `Your ${details.reviewId ? 'review image' : 'example image'} on the ${
          details.modelName
        } model has received ${details.reactionCount} reactions`;
      }

      return { message, url: `/images/${details.imageId}?postId=${details.postId}` };
    },
  },
  'article-reaction-milestone': {
    displayName: 'Article reaction milestones',
    category: NotificationCategory.Milestone,
    prepareMessage: ({ details }) => {
      const message = `Your article, "${details.articleTitle}" has received ${details.reactionCount} reactions`;

      return { message, url: `/articles/${details.articleId}` };
    },
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${articleReactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "articleId" affected_id
        FROM "ArticleReaction"
        WHERE "createdAt" > '${lastSent}'
      ), affected_value AS (
        SELECT
          a.affected_id,
          COUNT(r."articleId") reaction_count
        FROM "ArticleReaction" r
        JOIN affected a ON a.affected_id = r."articleId"
        GROUP BY a.affected_id
        HAVING COUNT(*) >= ${articleReactionMilestones[0]}
      ), reaction_milestone AS (
        SELECT
          a."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'articleId', a.id,
            'articleTitle', a.title,
            'reactionCount', ms.value
          ) "details"
        FROM affected_value af
        JOIN "Article" a on a.id = af.affected_id
        JOIN milestones ms ON ms.value <= af.reaction_count
            AND a."createdAt" > '${milestoneNotificationFix}'
      )
      SELECT
        CONCAT('article-reaction-milestone:', details->>'articleId', ':', details->>'reactionCount') "key",
        "ownerId"    "userId",
        'article-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-reaction-milestone')
    `,
  },
});

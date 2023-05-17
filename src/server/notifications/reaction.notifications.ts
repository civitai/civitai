import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { humanizeList } from '~/utils/humanizer';

const commentReactionMilestones = [5, 10, 20, 50, 100] as const;
const reviewReactionMilestones = [5, 10, 20, 50, 100] as const;
const imageReactionMilestones = [5, 10, 20, 50, 100] as const;
const articleReactionMilestones = [5, 10, 20, 50, 100] as const;

export const reactionNotifications = createNotificationProcessor({
  'comment-reaction-milestone': {
    displayName: 'Comment reaction milestones',
    prepareMessage: ({ details }) => ({
      message: `Your comment on ${details.modelName} has received ${details.reactionCount} reactions`,
      url: `/models/${details.modelId}?modal=commentThread&commentId=${details.rootCommentId}`,
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
        HAVING COUNT(*) > 5
      ), prior_milestones AS (
        SELECT DISTINCT
          affected_id,
          cast(details->'reactionCount' as int) reaction_count
        FROM "Notification"
        JOIN affected ON affected_id = cast(details->'commentId' as int)
        WHERE type = 'comment-reaction-milestone'
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
        LEFT JOIN prior_milestones pm ON pm.reaction_count >= ms.value AND pm.affected_id = a.affected_id
        WHERE pm.affected_id IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'comment-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'comment-reaction-milestone');
    `,
  },
  // No more review reactions
  // 'review-reaction-milestone': {
  //   displayName: 'Review reaction milestones',
  //   prepareMessage: ({ details }) => ({
  //     message: `Your review on ${details.modelName} has received ${details.reactionCount} reactions`,
  //     url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}`,
  //   }),
  //   prepareQuery: ({ lastSent }) => `
  //     WITH milestones AS (
  //       SELECT * FROM (VALUES ${reviewReactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
  //     ), affected AS (
  //       SELECT DISTINCT
  //         "reviewId" affected_id
  //       FROM "ReviewReaction"
  //       WHERE "createdAt" > '${lastSent}'
  //     ), affected_value AS (
  //       SELECT
  //         a.affected_id,
  //         COUNT(r."reviewId") reaction_count
  //       FROM "ReviewReaction" r
  //       JOIN affected a ON a.affected_id = r."reviewId"
  //       GROUP BY a.affected_id
  //       HAVING COUNT(*) > 5
  //     ), prior_milestones AS (
  //       SELECT DISTINCT
  //         affected_id,
  //         cast(details->'reactionCount' as int) reaction_count
  //       FROM "Notification"
  //       JOIN affected ON affected_id = cast(details->'reviewId' as int)
  //       WHERE type = 'review-reaction-milestone'
  //     ), reaction_milestone AS (
  //       SELECT
  //         r."userId" "ownerId",
  //         JSON_BUILD_OBJECT(
  //           'modelName', m.name,
  //           'modelId', m.id,
  //           'reviewId', r.id,
  //           'reactionCount', ms.value
  //         )          "details"
  //       FROM affected_value a
  //       JOIN "Review" r on r.id = a.affected_id
  //       JOIN "Model" m ON m.id = r."modelId"
  //       JOIN milestones ms ON ms.value <= a.reaction_count
  //       LEFT JOIN prior_milestones pm ON pm.reaction_count >= ms.value AND pm.affected_id = a.affected_id
  //       WHERE pm.affected_id IS NULL
  //     )
  //     INSERT INTO "Notification"("id", "userId", "type", "details")
  //     SELECT
  //       REPLACE(gen_random_uuid()::text, '-', ''),
  //       "ownerId"    "userId",
  //       'review-reaction-milestone' "type",
  //       details
  //     FROM reaction_milestone
  //     WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'review-reaction-milestone');
  //   `,
  // },
  'image-reaction-milestone': {
    displayName: 'Image reaction milestones',
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
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${imageReactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "imageId" affected_id
        FROM "ImageReaction"
        WHERE "createdAt" > '${lastSent}'
      ), affected_value AS (
        SELECT
          a.affected_id,
          COUNT(r."imageId") reaction_count
        FROM "ImageReaction" r
        JOIN affected a ON a.affected_id = r."imageId"
        GROUP BY a.affected_id
        HAVING COUNT(*) > 5
      ), prior_milestones AS (
        SELECT DISTINCT
          affected_id,
          cast(details->'reactionCount' as int) reaction_count
        FROM "Notification"
        JOIN affected ON affected_id = cast(details->'imageId' as int)
        WHERE type = 'image-reaction-milestone'
      ), reaction_milestone AS (
        SELECT
          i."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'version', 2,
            'imageId', i.id,
            'postId', i."postId",
            'models', ir.models,
            'reactionCount', ms.value
          ) "details"
        FROM affected_value a
        JOIN "Image" i on i.id = a.affected_id
        LEFT JOIN (
          SELECT ir."imageId", json_agg(m.name) models
          FROM "ImageResource" ir
          JOIN "ModelVersion" mv ON mv.id = ir."modelVersionId"
          JOIN "Model" m ON m.id = mv."modelId"
          GROUP BY ir."imageId"
        ) ir ON ir."imageId" = i.id
        JOIN milestones ms ON ms.value <= a.reaction_count
        WHERE NOT EXISTS (SELECT 1 FROM prior_milestones pm WHERE pm.affected_id = a.affected_id AND pm.reaction_count >= ms.value)
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'image-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'image-reaction-milestone');
    `,
  },
  'article-reaction-milestone': {
    displayName: 'Article reaction milestones',
    prepareMessage: ({ details }) => {
      const message = `Your article, "${details.name}" has received ${details.reactionCount} reactions`;

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
        HAVING COUNT(*) > ${articleReactionMilestones[0]}
      ), prior_milestones AS (
        SELECT DISTINCT
          affected_id,
          cast(details->'reactionCount' as int) reaction_count
        FROM "Notification"
        JOIN affected ON affected_id = cast(details->'articleId' as int)
        WHERE type = 'article-reaction-milestone'
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
        WHERE NOT EXISTS (SELECT 1 FROM prior_milestones pm WHERE pm.affected_id = af.affected_id AND pm.reaction_count >= ms.value)
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'article-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'article-reaction-milestone');
    `,
  },
});

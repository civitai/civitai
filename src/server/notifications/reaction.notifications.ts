import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const commentReactionMilestones = [5, 10, 20, 50, 100] as const;
const reviewReactionMilestones = [5, 10, 20, 50, 100] as const;

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
  'review-reaction-milestone': {
    displayName: 'Review reaction milestones',
    prepareMessage: ({ details }) => ({
      message: `Your review on ${details.modelName} has received ${details.reactionCount} reactions`,
      url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES ${reviewReactionMilestones.map((x) => `(${x})`).join(', ')}) m(value)
      ), affected AS (
        SELECT DISTINCT
          "reviewId" affected_id
        FROM "ReviewReaction"
        WHERE "createdAt" > '${lastSent}'
      ), affected_value AS (
        SELECT
          a.affected_id,
          COUNT(r."reviewId") reaction_count
        FROM "ReviewReaction" r
        JOIN affected a ON a.affected_id = r."reviewId"
        GROUP BY a.affected_id
        HAVING COUNT(*) > 5
      ), prior_milestones AS (
        SELECT DISTINCT
          affected_id,
          cast(details->'reactionCount' as int) reaction_count
        FROM "Notification"
        JOIN affected ON affected_id = cast(details->'reviewId' as int)
        WHERE type = 'review-reaction-milestone'
      ), reaction_milestone AS (
        SELECT
          r."userId" "ownerId",
          JSON_BUILD_OBJECT(
            'modelName', m.name,
            'modelId', m.id,
            'reviewId', r.id,
            'reactionCount', ms.value
          )          "details"
        FROM affected_value a
        JOIN "Review" r on r.id = a.affected_id
        JOIN "Model" m ON m.id = r."modelId"
        JOIN milestones ms ON ms.value <= a.reaction_count
        LEFT JOIN prior_milestones pm ON pm.reaction_count >= ms.value AND pm.affected_id = a.affected_id
        WHERE pm.affected_id IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'review-reaction-milestone' "type",
        details
      FROM reaction_milestone
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'review-reaction-milestone');
    `,
  },
  'image-reaction-milestone': {
    displayName: 'Image reaction milestones',
    prepareMessage: ({ details }) => {
      // Prep message
      const message = `Your ${details.reviewId ? 'review image' : 'example image'} on the ${
        details.modelName
      } model has received ${details.reactionCount} reactions`;

      // Prep URL
      const searchParams: Record<string, string> = {
        model: details.modelId,
        modelVersionId: details.modelVersionId,
        highlight: details.commentId,
        infinite: 'false',
      };
      if (details.reviewId) {
        searchParams.review = details.reviewId;
        searchParams.returnUrl = `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}`;
      } else {
        searchParams.returnUrl = `/models/${details.modelId}`;
      }
      const url = `/gallery/${details.imageId}?${new URLSearchParams(searchParams).toString()}`;

      return { message, url };
    },
    prepareQuery: ({ lastSent }) => `
      WITH milestones AS (
        SELECT * FROM (VALUES (5), (10), (20)) m(value)
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
            'imageId', ic."imageId",
            'modelName', m.name,
            'modelId', m.id,
            'modelVersionId', ic."modelVersionId",
            'reviewId', ic."reviewId",
            'reactionCount', ms.value
          ) "details"
        FROM affected_value a
        JOIN "Image" i on i.id = a.affected_id
        JOIN "ImageConnection" ic ON ic."imageId" = a.affected_id
        JOIN "Model" m ON m.id = ic."modelId"
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
});

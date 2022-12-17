import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New Comments on your Models',
    prepareMessage: ({ details }) => ({
      message: `${details.username} just commented on your ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=commentThread&commentId=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."parentId" IS NULL
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m."userId"
      )
      INSERT
      INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment' "type",
        details
      FROM new_comments
      LEFT JOIN "UserNotificationSettings" no ON no."userId" = "ownerId"
      WHERE no."userId" IS NULL;
    `,
  },
  'new-comment-response': {
    displayName: 'New Comment Responses',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has responded to your comment on the ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=commentThread&commentId=${
        details.parentId ?? details.commentId
      }&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comment_response AS (
        SELECT DISTINCT
          p."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', p.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "Comment" p ON p.id = c."parentId"
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != p."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-response' "type",
        details
      FROM new_comment_response
      LEFT JOIN "UserNotificationSettings" no ON no."userId" = "ownerId"
      WHERE no."userId" IS NULL;
    `,
  },
  'new-review-response': {
    displayName: 'New Review Responses',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has responded to your review on the ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}&commentId=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_review_response AS (
        SELECT DISTINCT
          r."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'reviewId', r.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "Review" r ON r.id = c."reviewId"
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != r."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-review-response' "type",
        details
      FROM new_review_response;
    `,
  },
});

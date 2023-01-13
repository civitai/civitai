import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New comments on your models',
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
          AND c."reviewId" IS NULL
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
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment');
    `,
  },
  'new-comment-response': {
    displayName: 'New comment responses',
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
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-response');
    `,
  },
  'new-review-response': {
    displayName: 'New review responses',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has responded to your review on the ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}&highlight=${details.commentId}`,
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
      FROM new_review_response
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-review-response');
    `,
  },
  'new-comment-nested': {
    displayName: 'New responses to comments and reviews on your models',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has responded to a ${details.parentType} on your ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments_nested AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', COALESCE(c."parentId", c."reviewId"),
            'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND (c."parentId" IS NOT NULL OR c."reviewId" IS NOT NULL)
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-nested' "type",
        details
      FROM new_comments_nested;
    `,
  },
  'new-thread-response': {
    displayName: 'New replies to comment threads you are in',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has responded to the ${details.parentType} thread on the ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH users_in_thread AS (
        SELECT DISTINCT
          CASE WHEN "parentId" IS NOT NULL THEN 'comment' ELSE 'review' END "type",
          COALESCE("reviewId", "parentId") AS "parentId",
          "userId"
        FROM "Comment"
        WHERE "reviewId" IS NOT NULL OR "parentId" IS NOT NULL
      ), new_thread_response AS (
        SELECT DISTINCT
          uit."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', COALESCE(c."parentId", c."reviewId"),
            'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "Model" m ON m.id = c."modelId"
        JOIN "User" u ON c."userId" = u.id
        JOIN users_in_thread uit
          ON (
            (uit.type = 'review' AND uit."parentId" = c."reviewId")
            OR (uit.type = 'comment' AND uit."parentId" = c."parentId")
          ) AND uit."userId" != c."userId"
        WHERE (c."parentId" IS NOT NULL OR c."reviewId" IS NOT NULL)
          AND c."createdAt" > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-thread-response' "type",
        details
      FROM new_thread_response;
    `,
  },
});

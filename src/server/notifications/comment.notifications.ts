import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const threadUrlMap = ({ threadType, threadParentId, ...details }: any) => {
  return {
    model: `/models/${threadParentId}?modal=commentThread&threadId=${details.threadId}&highlight=${details.commentId}`,
    image: `/images/${threadParentId}?highlight=${details.commentId}`,
    post: `/posts/${threadParentId}?highlight=${details.commentId}#comments`,
    article: `/articles/${threadParentId}?highlight=${details.commentId}#comments`,
    review: `/reviews/${threadParentId}?highlight=${details.commentId}`,
    // question: `/questions/${threadParentId}?highlight=${details.commentId}#comments`,
    // answer: `/questions/${threadParentId}?highlight=${details.commentId}#answer-`,
  }[threadType as string] as string;
};

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New comments on your models',
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your ${details.modelName} model`,
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
      FROM new_comments r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."userId" = r."ownerId"
              AND n."createdAt" > now() - interval '1 hour'
              AND n.type IN ('new-mention')
              AND n.details->>'commentId' = r.details->>'commentId'
        );
    `,
  },
  'new-comment-response': {
    displayName: 'New comment responses',
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to your comment on the ${details.modelName} model`,
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
      FROM new_comment_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-response')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."userId" = r."ownerId"
              AND n."createdAt" > now() - interval '1 hour'
              AND n.type IN ('new-comment-nested', 'new-thread-response', 'new-mention')
              AND n.details->>'commentId' = r.details->>'commentId'
        );
    `,
  },
  'new-comment-nested': {
    displayName: 'New responses to comments and reviews on your models',
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to a ${details.parentType} on your ${details.modelName} model`,
      url: `/models/${details.modelId}?modal=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_comments_nested AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', c."parentId",
            'parentType', CASE WHEN c."parentId" IS NOT NULL THEN 'comment' ELSE 'review' END,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Model" m ON m.id = c."modelId"
        WHERE m."userId" > 0
          AND c."parentId" IS NOT NULL
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != m."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-nested' "type",
        details
      FROM new_comments_nested r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-nested')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."userId" = r."ownerId"
              AND n."createdAt" > now() - interval '1 hour'
              AND n.type IN ('new-thread-response', 'new-comment-response', 'new-mention', 'new-comment-nested')
              AND n.details->>'commentId' = r.details->>'commentId'
        );
    `,
  },
  'new-thread-response': {
    displayName: 'New replies to comment threads you are in',
    prepareMessage: ({ details }) => {
      if (!details.version) {
        return {
          message: `${details.username} responded to the ${details.parentType} thread on the ${details.modelName} model`,
          url: `/models/${details.modelId}?modal=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      }

      const url = threadUrlMap(details);
      return {
        message: `${details.username} responded to a ${details.threadType} thread you're in`,
        url,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_thread_response AS (
        SELECT DISTINCT
          UNNEST((SELECT ARRAY_AGG("userId") FROM "Comment" cu WHERE cu."parentId" = c."parentId" AND cu."userId" != c."userId")) "ownerId",
          JSONB_BUILD_OBJECT(
            'modelId', c."modelId",
            'commentId', c.id,
            'parentId', c."parentId",
            'parentType', 'comment',
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Comment" c
        JOIN "Model" m ON m.id = c."modelId"
        JOIN "User" u ON c."userId" = u.id
        WHERE c."parentId" IS NOT NULL AND c."createdAt" > '${lastSent}'

        UNION

        SELECT DISTINCT
          UNNEST((SELECT ARRAY_AGG("userId") FROM "CommentV2" cu WHERE cu."threadId" = c."threadId" AND cu."userId" != c."userId")) "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'commentId', c.id,
            'threadId', c."threadId",
            'threadParentId', COALESCE(t."imageId", t."modelId", t."postId", t."questionId", t."answerId", t."reviewId", t."articleId"),
            'threadType', CASE
              WHEN t."imageId" IS NOT NULL THEN 'image'
              WHEN t."modelId" IS NOT NULL THEN 'model'
              WHEN t."postId" IS NOT NULL THEN 'post'
              WHEN t."questionId" IS NOT NULL THEN 'question'
              WHEN t."answerId" IS NOT NULL THEN 'answer'
              WHEN t."reviewId" IS NOT NULL THEN 'review'
              WHEN t."articleId" IS NOT NULL THEN 'article'
              ELSE 'comment'
            END,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId"
        JOIN "User" u ON c."userId" = u.id
        WHERE c."createdAt" > '${lastSent}'
          -- Unhandled thread types...
          AND t."questionId" IS NULL
          AND t."answerId" IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-thread-response' "type",
        details
      FROM new_thread_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-thread-response')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."userId" = r."ownerId"
              AND n."createdAt" > now() - interval '1 hour'
              AND n.type IN ('new-comment-nested', 'new-comment-response', 'new-mention', 'new-article-comment', 'new-image-comment')
              AND n.details->>'commentId' = r.details->>'commentId'
        );
    `,
  },
  'new-review-response': {
    displayName: 'New review responses',
    prepareMessage: ({ details }) => {
      if (details.version !== 2) {
        return {
          message: `${details.username} responded to your review on the ${details.modelName} model`,
          url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}&highlight=${details.commentId}`,
        };
      }

      return {
        message: `${details.username} responded to your review on the ${details.modelName} model`,
        url: `/reviews/${details.reviewId}?highlight=${details.commentId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
    WITH new_review_response AS (
      SELECT DISTINCT
        r."userId" "ownerId",
        JSONB_BUILD_OBJECT(
          'version', 2,
          'modelId', r."modelId",
          'commentId', c.id,
          'reviewId', r.id,
          'modelName', m.name,
          'username', u.username
        ) "details"
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      JOIN "ResourceReview" r ON r.id = t."reviewId"
      JOIN "User" u ON c."userId" = u.id
      JOIN "Model" m ON m.id = r."modelId"
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
      FROM new_review_response r
      WHERE
      NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-review-response')
      AND NOT EXISTS (
        SELECT 1
        FROM "Notification" n
        WHERE n."userId" = r."ownerId"
            AND n."createdAt" > now() - interval '1 hour'
            AND n.type IN ('new-comment-nested', 'new-thread-response', 'new-mention')
            AND n.details->>'commentId' = r.details->>'commentId'
      );
    `,
  },
  'new-image-comment': {
    displayName: 'New comments on your images',
    prepareMessage: ({ details }) => {
      if (details.version === 2) {
        let message = `${details.username} commented on your image`;
        if (details.modelName) message += ` posted to the ${details.modelName} model`;

        const url = `/images/${details.imageId}?postId=${details.postId}&highlight=${details.commentId}`;
        return { message, url };
      }

      // Prep message
      const message = `${details.username} commented on your ${
        details.reviewId ? 'review image' : 'example image'
      } posted to the ${details.modelName} model`;

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
      const url = `/images/${details.imageId}?${new URLSearchParams(searchParams).toString()}`;

      return { message, url };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_image_comment AS (
        SELECT DISTINCT
          i."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'imageId', t."imageId",
            'postId', i."postId",
            'commentId', c.id,
            'username', u.username,
            'modelName', m.name,
            'modelId', m.id,
            'modelVersionId', p."modelVersionId",
            'modelVersionName', mv.name
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId" AND t."imageId" IS NOT NULL
        JOIN "Image" i ON i.id = t."imageId"
        JOIN "Post" p ON p.id = i."postId"
        LEFT JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
        LEFT JOIN "Model" m ON m.id = mv."modelId"
        JOIN "User" u ON c."userId" = u.id
        WHERE m."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != i."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-image-comment' "type",
        details
      FROM new_image_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-image-comment');
    `,
  },
  'new-article-comment': {
    displayName: 'New comments on your articles',
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your article: "${details.articleTitle}"`,
      url: `/articles/${details.articleId}?highlight=${details.commentId}#comments`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_article_comment AS (
        SELECT DISTINCT
          a."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'articleId', a.id,
            'articleTitle', a.title,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."articleId" IS NOT NULL
        JOIN "Article" a ON a.id = t."articleId"
        WHERE a."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != a."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-article-comment' "type",
        details
      FROM new_article_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-article-comment');
    `,
  },
});

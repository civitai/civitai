import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { QS } from '../../utils/qs';
import { startCase } from 'lodash-es';

export const threadUrlMap = ({ threadType, threadParentId, ...details }: any) => {
  const queryString = QS.stringify({
    highlight: details.commentId,
    commentParentType: details.commentParentType,
    commentParentId: details.commentParentId,
    threadId: details.threadId,
  });

  return {
    model: `/models/${threadParentId}?dialog=commentThread&${queryString}`,
    image: `/images/${threadParentId}?${queryString}`,
    post: `/posts/${threadParentId}?${queryString}#comments`,
    article: `/articles/${threadParentId}?${queryString}#comments`,
    review: `/reviews/${threadParentId}?${queryString}`,
    bounty: `/bounties/${threadParentId}?${queryString}#comments`,
    bountyEntry: `/bounties/entries/${threadParentId}?${queryString}#comments`,
    // question: `/questions/${threadParentId}?highlight=${details.commentId}#comments`,
    // answer: `/questions/${threadParentId}?highlight=${details.commentId}#answer-`,
  }[threadType as string] as string;
};

export const commentNotifications = createNotificationProcessor({
  'new-comment': {
    displayName: 'New comments on your models',
    category: 'Comment',
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=commentThread&commentId=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
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
      INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment' "type",
        details,
        '${category}'::"NotificationCategory" "category"
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
    displayName: 'New comment responses (Models)',
    category: 'Comment',
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to your comment on the ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=commentThread&commentId=${
        details.parentId ?? details.commentId
      }&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-response' "type",
        details,
        '${category}'::"NotificationCategory" "category"
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
    category: 'Comment',
    prepareMessage: ({ details }) => ({
      message: `${details.username} responded to a ${details.parentType} on your ${details.modelName} model`,
      url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-nested' "type",
        details,
        '${category}'::"NotificationCategory" "category"
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
  'new-comment-reply': {
    displayName: 'New comment replies',
    category: 'Comment',
    prepareMessage: ({ details }) => {
      const url = threadUrlMap(details);
      return {
        message: `${details.username} replied to a ${details.threadType} comment you made`,
        url,
      };
    },
    prepareQuery: ({ lastSent, category }) => `
      WITH new_comment_reply AS (
        SELECT DISTINCT
          pc."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'commentId', c.id,
            'threadId', c."threadId",
            'threadParentId', COALESCE(
                root."imageId",
                root."modelId",
                root."postId",
                root."questionId",
                root."answerId",
                root."reviewId",
                root."articleId",
                root."bountyId",
                root."bountyEntryId"
             ),
            'threadType', CASE
                WHEN root."imageId" IS NOT NULL THEN 'image'
                WHEN root."modelId" IS NOT NULL THEN 'model'
                WHEN root."postId" IS NOT NULL THEN 'post'
                WHEN root."questionId" IS NOT NULL THEN 'question'
                WHEN root."answerId" IS NOT NULL THEN 'answer'
                WHEN root."reviewId" IS NOT NULL THEN 'review'
                WHEN root."articleId" IS NOT NULL THEN 'article'
                WHEN root."bountyId" IS NOT NULL THEN 'bounty'
                WHEN root."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
                ELSE 'comment'
                END,
             'commentParentId', t."commentId",
             'commentParentType', 'comment',
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId"
        JOIN "CommentV2" pc ON pc.id = t."commentId"
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" root ON root.id = t."rootThreadId"
        WHERE c."createdAt" > '${lastSent}' AND c."userId" != pc."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-comment-reply' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_comment_reply r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-comment-reply')
    `,
  },
  'new-thread-response': {
    displayName: 'New replies to comment threads you are in',
    category: 'Comment',
    prepareMessage: ({ details }) => {
      if (!details.version) {
        return {
          message: `${details.username} responded to the ${details.parentType} thread on the ${details.modelName} model`,
          url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      }

      const url = threadUrlMap(details);
      return {
        message: `${details.username} responded to a ${startCase(
          details.threadType
        )} thread you're in`,
        url,
      };
    },
    prepareQuery: ({ lastSent, category }) => `
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
            'threadParentId', COALESCE(
                root."imageId",
                root."modelId",
                root."postId",
                root."questionId",
                root."answerId",
                root."reviewId",
                root."articleId",
                root."bountyId",
                root."bountyEntryId",
                t."imageId",
                t."modelId",
                t."postId",
                t."questionId",
                t."answerId",
                t."reviewId",
                t."articleId",
                t."bountyId",
                t."bountyEntryId"
             ),
            'threadType', CASE
              WHEN COALESCE(root."imageId", t."imageId") IS NOT NULL THEN 'image'
              WHEN COALESCE(root."modelId", t."modelId") IS NOT NULL THEN 'model'
              WHEN COALESCE(root."postId", t."postId") IS NOT NULL THEN 'post'
              WHEN COALESCE(root."questionId", t."questionId") IS NOT NULL THEN 'question'
              WHEN COALESCE(root."answerId", t."answerId") IS NOT NULL THEN 'answer'
              WHEN COALESCE(root."reviewId", t."reviewId") IS NOT NULL THEN 'review'
              WHEN COALESCE(root."articleId", t."articleId") IS NOT NULL THEN 'article'
              WHEN COALESCE(root."bountyId", t."bountyId") IS NOT NULL THEN 'bounty'
              WHEN COALESCE(root."bountyEntryId", t."bountyEntryId") IS NOT NULL THEN 'bountyEntry'
              ELSE 'comment'
            END,
             'commentParentId', COALESCE(
                t."imageId",
                t."modelId",
                t."postId",
                t."questionId",
                t."answerId",
                t."reviewId",
                t."articleId",
                t."bountyId",
                t."bountyEntryId",
                t."commentId"
             ),
             'commentParentType', CASE
                WHEN t."imageId" IS NOT NULL THEN 'image'
                WHEN t."modelId" IS NOT NULL THEN 'model'
                WHEN t."postId" IS NOT NULL THEN 'post'
                WHEN t."questionId" IS NOT NULL THEN 'question'
                WHEN t."answerId" IS NOT NULL THEN 'answer'
                WHEN t."reviewId" IS NOT NULL THEN 'review'
                WHEN t."articleId" IS NOT NULL THEN 'article'
                WHEN t."bountyId" IS NOT NULL THEN 'bounty'
                WHEN t."bountyEntryId" IS NOT NULL THEN 'bountyEntry'
                ELSE 'comment'
              END,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "Thread" t ON t.id = c."threadId"
        JOIN "User" u ON c."userId" = u.id
        LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
        WHERE c."createdAt" > '${lastSent}'
          -- Unhandled thread types...
          AND t."questionId" IS NULL
          AND t."answerId" IS NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-thread-response' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_thread_response r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-thread-response')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."userId" = r."ownerId"
              AND n."createdAt" > now() - interval '1 hour'
              AND n.type IN ('new-comment-nested', 'new-comment-response', 'new-mention', 'new-article-comment', 'new-image-comment', 'new-comment-reply')
              AND n.details->>'commentId' = r.details->>'commentId'
        );
    `,
  },
  'new-review-response': {
    displayName: 'New review responses',
    category: 'Comment',
    prepareMessage: ({ details }) => {
      if (details.version !== 2) {
        return {
          message: `${details.username} responded to your review on the ${details.modelName} model`,
          url: `/models/${details.modelId}?dialog=reviewThread&reviewId=${details.reviewId}&highlight=${details.commentId}`,
        };
      }

      return {
        message: `${details.username} responded to your review on the ${details.modelName} model`,
        url: `/reviews/${details.reviewId}?highlight=${details.commentId}`,
      };
    },
    prepareQuery: ({ lastSent, category }) => `
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
      REPLACE(gen_random_uuid()::text, '-', ''),
      "ownerId"    "userId",
      'new-review-response' "type",
      details,
      '${category}'::"NotificationCategory" "category"
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
    category: 'Comment',
    prepareMessage: ({ details }) => {
      if (details.version === 2) {
        let message = `${details.username} commented on your image`;
        if (details.modelName) message += ` posted to the ${details.modelName} model`;

        const url = `/images/${details.imageId}?highlight=${details.commentId}`;
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
        searchParams.returnUrl = `/models/${details.modelId}?dialog=reviewThread&reviewId=${details.reviewId}`;
      } else {
        searchParams.returnUrl = `/models/${details.modelId}`;
      }
      const url = `/images/${details.imageId}?${new URLSearchParams(searchParams).toString()}`;

      return { message, url };
    },
    prepareQuery: ({ lastSent, category }) => `
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
        WHERE i."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."userId" != i."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-image-comment' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_image_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-image-comment');
    `,
  },
  'new-article-comment': {
    displayName: 'New comments on your articles',
    category: 'Comment',
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your article: "${details.articleTitle}"`,
      url: `/articles/${details.articleId}?highlight=${details.commentId}#comments`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH new_article_comment AS (
        SELECT DISTINCT
          a."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
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
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-article-comment' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_article_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-article-comment');
    `,
  },
  'new-bounty-comment': {
    displayName: 'New comments on your bounty',
    category: 'Comment',
    prepareMessage: ({ details }) => ({
      message: `${details.username} commented on your bounty: "${details.bountyTitle}"`,
      url: `/bounties/${details.bountyId}?highlight=${details.commentId}#comments`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      WITH new_bounty_comment AS (
        SELECT DISTINCT
          b."userId" "ownerId",
          JSONB_BUILD_OBJECT(
            'version', 2,
            'bountyId', b.id,
            'bountyTitle', b.name,
            'commentId', c.id,
            'username', u.username
          ) "details"
        FROM "CommentV2" c
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId" AND t."bountyId" IS NOT NULL
        JOIN "Bounty" b ON b.id = t."bountyId"
        WHERE b."userId" > 0
          AND c."createdAt" > '${lastSent}'
          AND c."createdAt" > '2024-02-24'
          AND c."userId" != b."userId"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-bounty-comment' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_bounty_comment
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-bounty-comment');
    `,
  },
});

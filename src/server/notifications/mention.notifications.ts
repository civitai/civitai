import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { threadUrlMap } from '~/server/notifications/comment.notifications';

export const mentionNotifications = createNotificationProcessor({
  'new-mention': {
    displayName: 'New @mentions',
    category: 'Comment',
    priority: -1,
    prepareMessage: ({ details }) => {
      const isCommentV2 = details.mentionedIn === 'comment' && details.threadId !== undefined;
      if (isCommentV2) {
        const url = threadUrlMap(details);
        return {
          message: `${details.username} mentioned you in a comment on a ${
            details.threadType === 'comment' ? 'comment thread' : details.threadType
          }`,
          url,
        };
      } else if (details.mentionedIn === 'comment') {
        if (details.parentType === 'review') return;

        return {
          message: `${details.username} mentioned you in a ${details.parentType} on ${details.modelName}`,
          url: `/models/${details.modelId}?dialog=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      }
      return {
        message: `${details.username} mentioned you in the description of ${details.modelName}`,
        url: `/models/${details.modelId}`,
      };
    },
    prepareQuery: ({ lastSent, category }) => `
      WITH new_mentions AS (
        SELECT DISTINCT
          CAST(unnest(regexp_matches(content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'mentionedIn', 'comment',
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
        JOIN "User" u ON c."userId" = u.id
        JOIN "Thread" t ON t.id = c."threadId"
        LEFT JOIN "Thread" root ON root.id = t."rootThreadId"
        WHERE (c."createdAt" > '${lastSent}')
          AND c.content LIKE '%"mention:%'
          -- Unhandled thread types...
          AND t."questionId" IS NULL
          AND t."answerId" IS NULL

        UNION

        SELECT DISTINCT
          CAST(unnest(regexp_matches(content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'mentionedIn', 'comment',
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
          AND (c."createdAt" > '${lastSent}')
          AND c.content LIKE '%"mention:%'

        UNION

        SELECT DISTINCT
          CAST(unnest(regexp_matches(m.description, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'mentionedIn', 'model',
            'modelId', m.id,
            'modelName', m.name,
            'username', u.username
          ) "details"
        FROM "Model" m
        JOIN "User" u ON m."userId" = u.id
        WHERE m."userId" > 0
          AND (m."publishedAt" > '${lastSent}' OR m."updatedAt" > '${lastSent}')
          AND m.description LIKE '%"mention:%'
          AND m.status = 'Published'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-mention' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_mentions r
      WHERE
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-mention')
        AND NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE "userId" = "ownerId" AND type = 'new-mention'
          AND (
            (n.details->>'mentionedIn' = 'model' AND r.details->>'modelId' = n.details->>'modelId') OR
            (n.details->>'mentionedIn' = 'comment' AND r.details->>'commentId' = n.details->>'commentId')
          )
        );`,
  },
});

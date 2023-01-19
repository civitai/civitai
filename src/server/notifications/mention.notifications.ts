import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const mentionNotifications = createNotificationProcessor({
  'new-mention': {
    displayName: 'New @mentions',
    priority: -1,
    prepareMessage: ({ details }) => {
      if (details.mentionedIn === 'comment')
        return {
          message: `${details.username} mentioned you in a ${details.parentType} on ${details.modelName}`,
          url: `/models/${details.modelId}?modal=${details.parentType}Thread&${details.parentType}Id=${details.parentId}&highlight=${details.commentId}`,
        };
      return {
        message: `${details.username} mentioned you in the description of ${details.modelName}`,
        url: `/models/${details.modelId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_mentions AS (
        SELECT DISTINCT
          CAST(unnest(regexp_matches(content, '"mention:(\\d+)"', 'g')) as INT) "ownerId",
          JSONB_BUILD_OBJECT(
            'mentionedIn', 'comment',
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
          AND (c."createdAt" > '${lastSent}' OR c."updatedAt" > '${lastSent}')
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
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'new-mention' "type",
        details
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

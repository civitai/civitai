import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reviewNotifications = createNotificationProcessor({
  'new-review': {
    displayName: 'New reviews',
    prepareMessage: ({ details }) => ({
      message: `${details.username} reviewed ${details.modelName} ${details.modelVersionName}`,
      url: `/models/${details.modelId}?modal=reviewThread&reviewId=${details.reviewId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH new_reviews AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          jsonb_build_object(
            'modelId', r."modelId",
            'reviewId', r.id,
            'modelName', m.name,
            'modelVersionName', mv.name,
            'username', u.username
          ) "details"
        FROM "Review" r
        JOIN "User" u ON r."userId" = u.id
        JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE
          m."userId" > 0 AND
          m."userId" != r."userId" AND
          r."createdAt" > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId" "userId",
        'new-review' "type",
        details
      FROM new_reviews
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-review');`,
  },
  'review-reminder': {
    displayName: 'Review reminders',
    prepareMessage: ({ details }) => ({
      message: `Remember to review "${details.modelName}"`,
      url: `/models/${details.modelId}?modal=reviewEdit`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH pending_reviews AS (
      SELECT DISTINCT
         ua."userId" "ownerId",
         m.id "modelId",
         JSONB_BUILD_OBJECT(
           'modelId', m.id,
           'modelName', m.name
         ) "details"
      FROM "UserActivity" ua
      JOIN "Model" m ON m.id = CAST(details->>'modelId' AS int)
      WHERE ua."userId" IS NOT NULL
        AND ua."createdAt" >= CURRENT_DATE-INTERVAL '72 hour'
        AND ua."createdAt" <= CURRENT_DATE-INTERVAL '71.75 hour'
        AND NOT EXISTS (SELECT 1 FROM "Review" r WHERE "modelId" = m.id AND r."userId" = ua."userId")
      ), de_duped AS (
        SELECT
          *
        FROM pending_reviews
        WHERE NOT EXISTS (
          SELECT 1 FROM "Notification" n
          WHERE type = 'review-reminder' AND "modelId" = cast(n.details->'modelId' as int)
        )
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId"    "userId",
        'review-reminder' "type",
        details
      FROM de_duped
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'review-reminder');
    `,
  },
});

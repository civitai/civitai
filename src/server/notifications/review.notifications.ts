import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reviewNotifications = createNotificationProcessor({
  'new-review': {
    displayName: 'New reviews',
    prepareMessage: ({ details }) => {
      if (details.version === 2) {
        let message = `${details.username} reviewed ${details.modelName} ${details.modelVersionName}`;
        if (details.rating) message += ` (${details.rating}/5)`;
        return {
          message,
          url: `/reviews/${details.reviewId}`,
        };
      }
      return {
        message: `${details.username} reviewed ${details.modelName} ${details.modelVersionName}`,
        url: `/redirect?to=review&reviewId=${details.reviewId}`,
      };
    },
    prepareQuery: ({ lastSent }) => `
      WITH new_reviews AS (
        SELECT DISTINCT
          m."userId" "ownerId",
          jsonb_build_object(
            'version', 2,
            'modelId', r."modelId",
            'reviewId', r.id,
            'modelName', m.name,
            'modelVersionName', mv.name,
            'username', u.username,
            'rating', r.rating
          ) "details"
        FROM "ResourceReview" r
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
      message: `Remember to review "${details.modelName} - ${details.modelVersionName}"`,
      url: `/models/${details.modelId}?modelVersionId=${details.modelVersionId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH pending_reviews AS (
        SELECT DISTINCT
          ua."userId" "ownerId",
          m.id as "modelId",
          mv.id as "modelVersionId",
          JSONB_BUILD_OBJECT(
            'modelId', m.id,
            'modelName', m.name,
            'modelVersionId', mv.id,
            'modelVersionName', mv.name
          ) "details"
        FROM "DownloadHistoryNew" ua
        JOIN "ModelVersion" mv ON mv.id = ua."modelVersionId" AND mv.status = 'Published'
        JOIN "Model" m ON m.id = mv."modelId" AND m.status = 'Published'
        WHERE ua."userId" IS NOT NULL
          AND ua."downloadAt" >= CURRENT_DATE-INTERVAL '72 hour'
          AND ua."downloadAt" <= CURRENT_DATE-INTERVAL '71.75 hour'
          AND NOT EXISTS (SELECT 1 FROM "ResourceReview" r WHERE "modelId" = m.id AND r."userId" = ua."userId")
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        CONCAT("ownerId",':','review-reminder',':',"modelVersionId") "id",
        "ownerId"    "userId",
        'review-reminder' "type",
        details
      FROM pending_reviews
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'review-reminder')
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});

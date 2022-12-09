import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reviewNotifications = createNotificationProcessor({
  'new-review': {
    displayName: 'New Reviews',
    prepareMessage: ({ details }) => ({
      message: `${details.username} reviewed ${details.modelName} ${details.modelVersionName}`,
      url: `/models/${details.modelId}?modal=review&reviewId=${details.reviewId}`,
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
          r."createdAt" > '${lastSent}'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
      SELECT
        REPLACE(gen_random_uuid()::text, '-', ''),
        "ownerId" "userId",
        'new-review' "type",
        details
      FROM new_reviews;`,
  },
});

import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const reviewNotifications = createNotificationProcessor({
  'new-review': {
    displayName: 'New reviews',
    category: 'Update',
    prepareMessage: ({ details }) => {
      if (details.version === 2) {
        const recommended = details.recommended ?? (!!details.rating && details.rating >= 3);
        const emoji = recommended ? '👍' : '👎';
        let message = `${details.username} gave ${details.modelName} ${details.modelVersionName} a ${emoji}`;
        if (details.imageCount) message += ` and posted ${details.imageCount} images`;
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
    prepareQuery: ({ lastSent, category }) => `
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
          'rating', r.rating,
          'recommended', r.recommended,
          'imageCount', (
              SELECT COUNT(*)
              FROM "Image" i
              JOIN "ImageResource" ir ON ir."imageId" = i.id AND ir."modelVersionId" = mv.id
              WHERE i."userId" = r."userId"
          )
        ) "details",
        r.details AS "content",
        r.id
      FROM "ResourceReview" r
      JOIN "User" u ON r."userId" = u.id
      JOIN "ModelVersion" mv ON mv.id = r."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE
        m."userId" > 0 AND
        m."userId" != r."userId" AND
        r."createdAt" > '${lastSent}'::timestamp - INTERVAL '5 minutes' AND
        r."createdAt" <= NOW() - INTERVAL '5 minutes'
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT('new-review',':',id) "id",
        "ownerId" "userId",
        'new-review' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM new_reviews
      WHERE
        (CAST(details->'imageCount' as int) > 0 OR content IS NOT NULL) AND
        NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'new-review')
      ON CONFLICT (id) DO NOTHING;`,
  },
  'review-reminder': {
    displayName: 'Review reminders',
    category: 'System',
    prepareMessage: ({ details }) => ({
      message: `Remember to review "${details.modelName} - ${details.modelVersionName}"`,
      url: `/models/${details.modelId}?modelVersionId=${details.modelVersionId}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
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
        FROM "DownloadHistory" ua
        JOIN "ModelVersion" mv ON mv.id = ua."modelVersionId" AND mv.status = 'Published'
        JOIN "Model" m ON m.id = mv."modelId" AND m.status = 'Published'
        WHERE ua."userId" IS NOT NULL
          AND ua."downloadAt" BETWEEN
            '${lastSent}'::timestamp - INTERVAL '72 hour' AND NOW() - INTERVAL '72 hour'
          AND NOT EXISTS (SELECT 1 FROM "ResourceReview" r WHERE "modelId" = m.id AND r."userId" = ua."userId")
      )
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT("ownerId",':','review-reminder',':',"modelVersionId") "id",
        "ownerId"    "userId",
        'review-reminder' "type",
        details,
        '${category}'::"NotificationCategory" "category"
      FROM pending_reviews
      WHERE NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = "ownerId" AND type = 'review-reminder')
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});

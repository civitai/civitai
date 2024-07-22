import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const imageNotifications = createNotificationProcessor({
  'profile-picture-blocked': {
    displayName: 'Avatar blocked',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message: 'Your avatar has been blocked.',
      url: '/user/account',
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          i.id "imageId",
          u.id as "userId"
        FROM "Image" i
        JOIN "User" u ON i.id = u."profilePictureId"
        WHERE i."updatedAt" > '${lastSent}' AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
      )
        SELECT
          CONCAT('profile-picture-blocked:',"imageId") "key",
          "userId",
          'profile-picture-blocked' "type",
          '{}'::jsonb "details"
        FROM data
    `,
  },
});

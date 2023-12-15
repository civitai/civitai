import { createNotificationProcessor } from '~/server/notifications/base.notifications';
export const imageNotifications = createNotificationProcessor({
  'profile-picture-blocked': {
    displayName: 'Profile picture blocked',
    toggleable: false,
    prepareMessage: () => ({
      message: 'Your profile picture has been blocked.',
      url: '/user/account',
    }),
    prepareQuery: async ({ lastSent }) => `
      WITH data AS (
        SELECT
          i.id "imageId",
          u.id "userId"
        FROM "Image" i 
        JOIN "User" u ON i.id = u."profilePictureId"
        WHERE i."updatedAt" > ${lastSent} AND i.ingestion = 'Blocked'::"ImageIngestionStatus"
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          CONCAT("userId",':','profile-picture-blocked',':',"imageId"),
          "userId",
          'profile-picture-blocked' "type",
          jsonb_build_object()
        FROM data
      ON CONFLICT("id") DO NOTHING;
    `,
  },
});

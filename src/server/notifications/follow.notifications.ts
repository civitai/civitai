import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const followNotifications = createNotificationProcessor({
  'followed-by': {
    displayName: 'New followers',
    category: 'Update',
    prepareMessage: ({ details }) => ({
      message: `${details.username} has followed you!`,
      url: `/user/${details.username}`,
    }),
    prepareQuery: ({ lastSent, category }) => `
      INSERT INTO "Notification"("id", "userId", "type", "details", "category")
      SELECT
        CONCAT('followed-by:',ue."userId",ue."targetUserId"),
        ue."targetUserId",
        'followed-by',
        jsonb_build_object(
          'userId', u.id,
          'username', u.username
        ),
        '${category}'::"NotificationCategory" "category"
      FROM "UserEngagement" ue
      JOIN "User" u ON u.id = ue."userId"
      WHERE ue.type = 'Follow' AND ue."createdAt" > '${lastSent}'
      AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = ue."targetUserId" AND type = 'followed-by')
      ON CONFLICT ("id") DO NOTHING;`,
  },
});

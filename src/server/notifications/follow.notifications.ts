import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const followNotifications = createNotificationProcessor({
  // Moveable
  'followed-by': {
    displayName: 'New followers',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => ({
      message: `${details.username} has followed you!`,
      url: `/user/${details.username}`,
    }),
    prepareQuery: ({ lastSent }) => `
      SELECT
        CONCAT('followed-by:',ue."userId",':',ue."targetUserId") "key",
        ue."targetUserId" as "userId",
        'followed-by' as "type",
        jsonb_build_object(
          'userId', u.id,
          'username', u.username
        ) "details"
      FROM "UserEngagement" ue
      JOIN "User" u ON u.id = ue."userId"
      WHERE ue.type = 'Follow' AND ue."createdAt" > '${lastSent}'
      AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = ue."targetUserId" AND type = 'followed-by')
    `,
  },
});

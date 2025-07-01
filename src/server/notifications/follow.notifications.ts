import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export type NotifDetailsFollowedBy = {
  username: string | null;
  // userId: number;
};

export const followNotifications = createNotificationProcessor({
  'followed-by': {
    displayName: 'New follower',
    category: NotificationCategory.Update,
    prepareMessage: ({ details }) => {
      const det = details as NotifDetailsFollowedBy;
      return {
        message: `${det.username ?? 'A user'} has followed you!`,
        url: det.username ? `/user/${det.username}` : undefined,
      };
    },
  },
});

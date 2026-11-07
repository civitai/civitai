import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

// Its query is in primary-notification-queries.ts: this file is bundled for the browser.
export const imageNotifications = createNotificationProcessor({
  'profile-picture-blocked': {
    displayName: 'Avatar blocked',
    category: NotificationCategory.Moderation,
    prepareMessage: () => ({
      message: 'Your avatar has been blocked.',
      url: '/user/account',
    }),
  },
});

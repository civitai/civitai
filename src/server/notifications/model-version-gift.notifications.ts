import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const modelVersionGiftNotifications = createNotificationProcessor({
  'gift-links-monthly-limit': {
    displayName: 'Gift links reached the monthly limit',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your gift links reached this month's limit of ${details.limit} claims, so new claims are paused until the 1st (UTC). A higher membership tier raises the limit.`,
      url: '/pricing',
    }),
  },
});

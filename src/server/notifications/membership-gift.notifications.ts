import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const membershipGiftNotifications = createNotificationProcessor({
  'membership-gift-received': {
    displayName: 'Membership Gift Received',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const from = details.from ? `@${details.from}` : 'Someone';
      const note = details.message ? ` They said: "${details.message}"` : '';
      return {
        message: `${from} gifted you ${details.months} month${
          details.months === 1 ? '' : 's'
        } of ${details.tier} membership! 🎁${note}`,
        url: '/user/membership',
      };
    },
  },
  'membership-gift-sent': {
    displayName: 'Membership Gift Sent',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your gift of ${details.months} month${
        details.months === 1 ? '' : 's'
      } of ${details.tier} membership has been delivered to @${details.to}`,
      url: '/user/membership',
    }),
  },
});

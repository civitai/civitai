import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { parseBuzzTransactionDetails } from '~/utils/buzz';

export const buzzNotifications = createNotificationProcessor({
  'tip-received': {
    displayName: 'Tip Received',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => {
      const { url, notification } = parseBuzzTransactionDetails(details);
      return {
        message: `${notification}${details.message ? ` They said: "${details.message}".` : ''}`,
        url,
      };
    },
  },
  'partially-paid': {
    displayName: 'Partially Paid',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => {
      return {
        message: `Thanks for purchasing Buzz via Crypto! We received a partial payment, likely due to network or conversion fees. You’ve been credited Buzz based on the amount received`,
        url: '/user/transactions',
      };
    },
  },
});

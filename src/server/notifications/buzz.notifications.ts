import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { parseBuzzTransactionDetails } from '~/utils/buzz';

export const buzzNotifications = createNotificationProcessor({
  'tip-received': {
    displayName: 'Tip Received',
    prepareMessage: ({ details }) => {
      const { url, notiifcation } = parseBuzzTransactionDetails(details);
      return {
        message: `${notiifcation}${details.message ? ` They said: "${details.message}".` : ''}`,
        url,
      };
    },
  },
});

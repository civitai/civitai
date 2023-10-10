import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const buzzNotifications = createNotificationProcessor({
  'tip-received': {
    displayName: 'Tip Received',
    prepareMessage: ({ details }) => ({
      message: `You received a tip of ${details.amount} Buzz from ${
        details.user ? `@${details.user}` : 'a user'
      }!${details.message ? ` They said: "${details.message}".` : ''}`,
      url: details.user !== 'a user' ? `/user/${details.user}` : '',
    }),
  },
});

import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const clubNotiifcations = createNotificationProcessor({
  'club-new-member-joined': {
    displayName: 'New Member Joined your club!',
    prepareMessage: ({ details }) => {
      return {
        message: `A new user has joined your club!`,
        url: `/clubs/${details.clubId}`,
      };
    },
  },
});

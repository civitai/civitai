import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const userJourneyNotifications = createNotificationProcessor({
  'join-community': {
    displayName: 'Welcome to Civitai',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message: `Happy to have you here! Come join our Discord server to stay up to date with the community and updates to the platform.`,
      url: `/discord`,
      target: '_blank',
    }),
  },
});

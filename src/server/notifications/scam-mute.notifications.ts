import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const scamMuteNotifications = createNotificationProcessor({
  'scam-muted': {
    displayName: 'Account paused for review',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message:
        'Your account has been paused while a moderator reviews recent activity on it. You will be notified when the review is complete.',
    }),
  },
  'scam-restriction-upheld': {
    displayName: 'Account restriction upheld',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.resolvedMessage
        ? `The restriction on your account has been reviewed and upheld: ${details.resolvedMessage}`
        : 'The restriction on your account has been reviewed and upheld.',
    }),
  },
  'scam-restriction-overturned': {
    displayName: 'Account restriction lifted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.resolvedMessage
        ? `Your account has been reviewed and the restriction lifted: ${details.resolvedMessage}`
        : 'Your account has been reviewed and the restriction lifted. Anything hidden during the review has been restored.',
    }),
  },
});

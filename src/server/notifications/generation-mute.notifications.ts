import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const generationMuteNotifications = createNotificationProcessor({
  'generation-muted': {
    displayName: 'Generation access restricted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message:
        'Your generation access has been restricted due to potential Terms of Service violations. A moderator will review your account within 2 business days.',
      url: '/generate',
    }),
  },
  'generation-restriction-upheld': {
    displayName: 'Generation restriction upheld',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.resolvedMessage
        ? `Your generation restriction has been reviewed and upheld: ${details.resolvedMessage}`
        : 'Your generation restriction has been reviewed and upheld.',
      url: '/generate',
    }),
  },
  'generation-restriction-overturned': {
    displayName: 'Generation access restored',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.resolvedMessage
        ? `Your generation access has been restored: ${details.resolvedMessage}`
        : 'Your generation access has been restored. You may now use the generation feature again.',
      url: '/generate',
    }),
  },
});

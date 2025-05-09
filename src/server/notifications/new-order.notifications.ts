import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const knightsNewOrderNotifications = createNotificationProcessor({
  'new-order-smite-received': {
    displayName: 'Knights of New Order: you got a smite!',
    prepareMessage: () => ({
      message:
        'Knights of New Order: Oh no! You got a smite because one of your ratings did not meet the guidelines. Jump back in to cleanse the smite as soon as possible!',
      url: '/games/knights-of-new-order',
    }),
    category: NotificationCategory.Other,
  },
  'new-order-smite-cleansed': {
    displayName: 'Knights of New Order: your smite was cleansed!',
    category: NotificationCategory.Other,
    prepareMessage: ({ details }) => ({
      message: `Knights of New Order: One of your smites was cleansed with the following reason: ${details.cleansedReason}`,
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-game-over': {
    displayName: 'Knights of New Order: Game Over 💀',
    category: NotificationCategory.Other,
    prepareMessage: () => ({
      message:
        'Knights of New Order: You just received your last smite and lost all your health! You career will be reset.',
      url: '/games/knights-of-new-order',
    }),
  },
});

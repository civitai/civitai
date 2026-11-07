import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

const KNIGHTS_APP_URL = 'https://knights.civitai.com';
const KNIGHTS_SECTION = 'Knights of New Order';

export const knightsNewOrderNotifications = createNotificationProcessor({
  'new-order-sanity-warning': {
    displayName: 'Knights of New Order: Performance Check Failed',
    category: NotificationCategory.Other,
    prepareMessage: ({ details }) => ({
      message:
        (details?.message as string) ||
        'Knights of New Order: Careful! You incorrectly rated a performance check image. Make sure you rate based on your acolyte training to avoid getting a Smite.',
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-smite-received': {
    displayName: 'Knights of New Order: Smite',
    prepareMessage: () => ({
      message:
        'Knights of New Order: Oh no! You got a smite because one of your ratings did not meet the guidelines. Jump back in to cleanse the smite as soon as possible!',
      url: '/games/knights-of-new-order',
    }),
    category: NotificationCategory.Other,
  },
  'new-order-smite-cleansed': {
    displayName: 'Knights of New Order: Cleansed Smite',
    category: NotificationCategory.Other,
    prepareMessage: ({ details }) => ({
      message: `Knights of New Order: One of your smites was cleansed with the following reason: ${
        details.cleansedReason as string
      }`,
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-game-over': {
    displayName: 'Knights of New Order: Game Over',
    category: NotificationCategory.Other,
    prepareMessage: ({ details }) => ({
      message: `Knights of New Order: ${
        (details.reason as string) || 'Your New Order career has been reset.'
      }`,
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-templar-promotion': {
    displayName: 'Knights of New Order: Templar Promotion',
    category: NotificationCategory.Other,
    prepareMessage: () => ({
      message: `Knights of New Order: Congratulations! You have been promoted to Templar because your fervor is outstangin! Keep up the good work!`,
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-knight-demoted': {
    displayName: 'Knights of New Order: Knight Demotion',
    category: NotificationCategory.Other,
    prepareMessage: () => ({
      message: `Knights of New Order: Oh no! You have been demoted to Knight because your fervor is not up to the standards. This update reflects recent activity levels and isn't permanent, you're always welcome to level up again through continued engagement.`,
      url: '/games/knights-of-new-order',
    }),
  },
  'new-order-blessed-buzz-granted': {
    displayName: 'Knights of New Order: Blessed Buzz Granted',
    category: NotificationCategory.Other,
    prepareMessage: ({ details }) => ({
      message: `Knights of New Order: You've received ${
        details.buzzAmount as number
      } Buzz from your banked Gold rewards! Thank you for your continued dedication to content moderation. Sorry for the delay!`,
      url: '/user/transactions',
    }),
  },
  'knights-verdicts-in': {
    displayName: 'Your verdicts are in',
    category: NotificationCategory.Other,
    section: KNIGHTS_SECTION,
    externalProducer: true,
    prepareMessage: () => ({
      message: 'Knights of New Order: Your verdicts are in. See how your judgments turned out.',
      url: `${KNIGHTS_APP_URL}/judgments`,
      target: '_blank',
    }),
  },
  'knights-streak-ends-soon': {
    displayName: 'Your streak ends soon',
    category: NotificationCategory.Other,
    section: KNIGHTS_SECTION,
    externalProducer: true,
    prepareMessage: () => ({
      message:
        "Knights of New Order: Your streak ends soon. Finish today's Daily Watch to keep it.",
      url: `${KNIGHTS_APP_URL}/play`,
      target: '_blank',
    }),
  },
  'knights-new-images': {
    displayName: 'New images to judge',
    category: NotificationCategory.Other,
    section: KNIGHTS_SECTION,
    externalProducer: true,
    prepareMessage: () => ({
      message: 'Knights of New Order: New images are waiting for your judgment.',
      url: `${KNIGHTS_APP_URL}/play`,
      target: '_blank',
    }),
  },
});

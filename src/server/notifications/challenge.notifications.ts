import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';

export const challengeNotifications = createNotificationProcessor({
  'challenge-winner': {
    displayName: 'Challenge Winner',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `You placed ${asOrdinal(details.position)} in the "${
        details.challengeName
      }" challenge! You've won ${numberWithCommas(details.prize)} Buzz.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-participation': {
    displayName: 'Challenge Participation',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `You've submitted enough entries to earn the participation prize in the "${
        details.challengeName
      }" challenge! You've won ${numberWithCommas(details.prize)} Buzz.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-rejection': {
    displayName: 'Challenge Rejection',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `${details.count} entries to the "${details.challengeName}" challenge have been declined. Consider making new entries to improve your chances of winning!`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
  'challenge-resource': {
    displayName: `Your resource has been selected for today's challenge`,
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your resource "${details.resourceName}" has been selected for the "${details.challengeName}" challenge! Check all the details by clicking on this notification.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
});

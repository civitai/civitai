import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';

export const challengeNotifications = createNotificationProcessor({
  'challenge-winner': {
    displayName: 'Challenge Winner',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      // A user challenge whose pool was never funded pays 0 — don't congratulate them on winning it.
      message: `You placed ${asOrdinal(details.position)} in the "${
        details.challengeName
      }" challenge!${
        details.prize > 0 ? ` You've won ${numberWithCommas(details.prize)} Buzz.` : ''
      }`,
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
  'challenge-cancelled': {
    displayName: 'Challenge Cancelled',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `The "${
        details.challengeTitle
      }" challenge was cancelled. The prize pool portion of your entry fee (${numberWithCommas(
        details.refundedBuzz
      )} Buzz per entry) has been refunded to your account — the platform fee portion of each entry is not refunded.`,
      url: `/challenges/${details.challengeId}`,
    }),
  },
});

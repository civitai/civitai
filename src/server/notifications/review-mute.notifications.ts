import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { strikeReasonPublicLabel } from '~/server/schema/strike.schema';
import { StrikeReason } from '~/shared/utils/prisma/enums';

export const reviewMuteNotifications = createNotificationProcessor({
  // Sent only for scam cases, which also issue a silent Scam strike: this is the event's one notice.
  'review-muted': {
    displayName: 'Account restricted',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: () => ({
      message: `Account restricted: ${
        strikeReasonPublicLabel[StrikeReason.Scam]
      }. A moderator will review this restriction and you will be notified of the outcome.`,
    }),
  },
  'review-restriction-upheld': {
    displayName: 'Account restriction upheld',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: details.resolvedMessage
        ? `The restriction on your account has been reviewed and upheld: ${details.resolvedMessage}`
        : 'The restriction on your account has been reviewed and upheld.',
    }),
  },
  'review-restriction-overturned': {
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

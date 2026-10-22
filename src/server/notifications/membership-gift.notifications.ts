import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { formatDate } from '~/utils/date-helpers';

export const membershipGiftNotifications = createNotificationProcessor({
  'membership-gift-received': {
    displayName: 'Membership Gift Received',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const from = details.from ? `@${details.from}` : 'Someone';
      const note = details.message ? ` They said: "${details.message}"` : '';
      return {
        message: `${from} gifted you ${details.months} month${details.months === 1 ? '' : 's'} of ${
          details.tier
        } membership! 🎁 Head to your membership page to start it.${note}`,
        url: '/user/membership#membership-gifts',
      };
    },
  },
  'membership-gift-sent': {
    displayName: 'Membership Gift Sent',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `Your gift of ${details.months} month${details.months === 1 ? '' : 's'} of ${
        details.tier
      } membership has been delivered to @${details.to}`,
      url: '/pricing/gift#membership-gifts',
    }),
  },
  'membership-gift-canceled': {
    displayName: 'Membership Gift Canceled',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const gift = `${details.months}-month ${details.tier} membership gift`;
      if (details.renewsAt)
        return {
          message: `Your ${gift} has been canceled because the gifter's payment didn't go through. This isn't anything you did. Your own membership continues, and your next renewal on ${formatDate(
            new Date(details.renewsAt * 1000),
            'MMMM D'
          )} will be billed at the regular price. You can change or cancel your membership anytime from your membership page.`,
          url: '/user/membership',
        };
      if (details.selfGift)
        return {
          message: `Your ${gift} has been canceled because the payment for it never arrived. If you'd still like a membership, you can start one anytime.`,
          url: '/pricing',
        };
      return {
        message: `The ${gift} you received has been canceled because the gifter's payment didn't go through. This isn't anything you did, and your account is in good standing.`,
        url: '/pricing',
      };
    },
  },
});

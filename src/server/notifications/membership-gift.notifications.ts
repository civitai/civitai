import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

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

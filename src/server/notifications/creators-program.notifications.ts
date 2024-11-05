import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorsProgramNotifications = createNotificationProcessor({
  'creators-program-enabled': {
    displayName: 'Creators program enabled',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your account is approved for Creator Payouts! Click this notification to set up your payment details to start receiving payments.`,
      url: `/user/account#payments`,
    }),
  },
  'creators-program-payments-enabled': {
    displayName: 'Payments enabled',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your account has been verified and approved for payments! You can now start earning money from your content!`,
      url: `/creators-program`,
    }),
  },
  'creators-program-rejected-stripe': {
    displayName: 'Creators program Rejected (Stripe)',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `We're sorry, but it looks like your stripe account has been rejected for payments. If you need more information, you can contact support.`,
      url: `/creators-program`,
    }),
  },
  'creators-program-withdrawal-approved': {
    displayName: 'Creators program - Withdrawal Approved',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your withdrawal request has been approved. Your funds will be transferred to your account soon`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-transferred': {
    displayName: 'Creators program - Money transferred',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your request has been processed and money has been transfered to your account.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-rejected': {
    displayName: 'Creators program - Withdrawal Rejected',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Moderators have rejected your withdrawal request. Please contact us for more information.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-reverted': {
    displayName: 'Creators program - Money reverted',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `We have decided to revert money that was transfered to your  account. Please contact us for more information on why we came to this desicion.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
});

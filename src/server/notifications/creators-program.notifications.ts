import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorsProgramNotifications = createNotificationProcessor({
  'creators-program-enabled': {
    displayName: 'Creators program enabled',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your account has been approved for the Civitai Creators Program! Setup your stripe account so you can start getting paid!.`,
      url: `/user/account#stripe`,
    }),
  },
  'creators-program-payments-enabled': {
    displayName: 'Payments enabled',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your stripe account has been verified and approved for payments! You can now start earning money from your content!`,
      url: `/creators-program`,
    }),
  },
  'creators-program-rejected-stripe': {
    displayName: 'Creators program Rejected (Stripe)',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `We're sorry, but it looks like your stripe account has been rejected for payments. If you need more information, you can contact support.`,
      url: `/creators-program`,
    }),
  },
  'creators-program-withdrawal-approved': {
    displayName: 'Creators program - Withdrawal Approved',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your withdrawal request has been approved. Your funds will be transferred to your stripe account soon`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-transferred': {
    displayName: 'Creators program - Money transferred',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your request has been processed and money has been transfered to your stripe account.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-rejected': {
    displayName: 'Creators program - Withdrawal Rejected',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `Moderators have rejected your withdrawal request. Please contact us for more information.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
  'creators-program-withdrawal-reverted': {
    displayName: 'Creators program - Money reverted',
    category: 'Buzz',
    toggleable: false,
    prepareMessage: () => ({
      message: `We have decided to revert money that was transfered to your stripe account. Please contact us for more information on why we came to this desicion.`,
      url: `/user/buzz-dashboard#buzz-withdrawals`,
    }),
  },
});

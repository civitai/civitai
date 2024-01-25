import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const creatorsProgramNotifications = createNotificationProcessor({
  'creators-program-enabled': {
    displayName: 'Creators program enabled',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your account has been approved for the Civitai Creators Program! Setup your stripe account so you can start getting paid!.`,
      url: `/user/account#stripe`,
    }),
  },
  'creators-program-payments-enabled': {
    displayName: 'Payments enabled',
    toggleable: false,
    prepareMessage: () => ({
      message: `Your stripe account has been verified and approved for payments! You can now start earning money from your content!`,
      url: `/creators-program`,
    }),
  },
  'creators-program-rejected-stripe': {
    displayName: 'Creators program Rejected (Stripe)',
    toggleable: false,
    prepareMessage: () => ({
      message: `We're sorry, but it looks like your stripe account has been rejected for payments. If you need more information, you can contact support.`,
      url: `/creators-program`,
    }),
  },
});

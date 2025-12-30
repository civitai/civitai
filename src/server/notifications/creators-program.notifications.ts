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
      url: `/creator-program`,
    }),
  },
  'creators-program-rejected-stripe': {
    displayName: 'Creators program Rejected (Stripe)',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `We're sorry, but it looks like your stripe account has been rejected for payments. If you need more information, you can contact support.`,
      url: `/creator-program`,
    }),
  },
  'creators-program-rejected-tipalti': {
    displayName: 'Creators program Rejected (Tipalti)',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `We're sorry, but it looks like your tipalti account has been rejected for payments. If you need more information, you can contact support. This is not Civitai's decision, but Tipalti's.`,
      url: `/creator-program`,
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
  'creators-program-withdrawal-updated': {
    displayName: 'Creators program - Withdrawal Updated',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => ({
      message: `Your withdrawal request has been updated. You may check the withdrawals' history for more information.`,
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

  // Creator Program V2:
  'creator-program-banking-phase-ending': {
    displayName: 'Banking phase ending',
    category: NotificationCategory.Creator,
    toggleable: false,
    showCategory: true,
    prepareMessage: () => ({
      message: `This is the last day to Bank Buzz before the Extraction Phase begins.`,
      url: `/user/buzz-dashboard#get-paid`,
    }),
  },
  'creator-program-extraction-phase-started': {
    displayName: 'Extraction phase started',
    category: NotificationCategory.Creator,
    toggleable: false,
    showCategory: true,
    prepareMessage: () => ({
      message: `The Extraction Phase has begun. Check the value of your Banked Buzz and decide what to do.`,
      url: `/user/buzz-dashboard#get-paid`,
    }),
  },
  'creator-program-extraction-phase-ending': {
    displayName: 'Extraction phase ending',
    category: NotificationCategory.Creator,
    toggleable: false,
    showCategory: true,
    prepareMessage: () => ({
      message: `This is the last day to Extract Buzz before the Creator Compensation Pool is distributed. Check the value of your Banked Buzz and decide what to do.`,
      url: `/user/buzz-dashboard#get-paid`,
    }),
  },
  'creator-program-funds-settled': {
    displayName: 'Funds settled',
    category: NotificationCategory.Creator,
    toggleable: false,
    showCategory: true,
    prepareMessage: ({ details }) => ({
      message: `Your funds earned from the Creator Compensation Pool have been settled. You can now withdraw your earnings.`,
      url: `/user/buzz-dashboard#get-paid`,
    }),
  },
});

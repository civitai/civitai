import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { parseBuzzTransactionDetails } from '~/utils/buzz';

export const buzzNotifications = createNotificationProcessor({
  'tip-received': {
    displayName: 'Tip Received',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => {
      const { url, notification } = parseBuzzTransactionDetails(details);
      return {
        message: `${notification}${details.message ? ` They said: "${details.message}".` : ''}`,
        url,
      };
    },
  },
  'deposit-confirmed': {
    displayName: 'Crypto Deposit Confirmed',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const buzzAmount = Number(details.buzzAmount).toLocaleString();
      const bonusText =
        details.bonusBuzz && Number(details.bonusBuzz) > 0
          ? ` (plus ${Number(details.bonusBuzz).toLocaleString()} bonus Buzz)`
          : '';
      return {
        message: `Your crypto deposit has been confirmed! ${buzzAmount} Buzz${bonusText} has been added to your account.`,
        url: '/user/transactions',
      };
    },
  },
  'partially-paid': {
    displayName: 'Partially Paid',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: () => {
      return {
        message: `Thanks for purchasing Buzz via Crypto! We received a partial payment, likely due to network or conversion fees. You've been credited Buzz based on the amount received`,
        url: '/user/transactions',
      };
    },
  },
  'redeemable-code-ready': {
    displayName: 'Redeemable Code Ready',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const description =
        details.codeType === 'Buzz'
          ? `${Number(details.unitValue).toLocaleString()} Buzz`
          : `${details.unitValue}-month Membership`;
      return {
        message: `Your crypto payment has been confirmed! Your redeemable code for ${description} is ready. View it in your account settings.`,
        url: '/user/account#purchased-codes',
      };
    },
  },
});

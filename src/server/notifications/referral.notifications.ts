import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const referralNotifications = createNotificationProcessor({
  'referral-reward-settled': {
    displayName: 'Referral Reward Settled',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => {
      const tokens = Number(details.tokens ?? 0);
      const blueBuzz = Number(details.blueBuzz ?? 0);
      const parts: string[] = [];
      if (tokens > 0) parts.push(`${tokens} token${tokens === 1 ? '' : 's'}`);
      if (blueBuzz > 0) parts.push(`${blueBuzz.toLocaleString()} Blue Buzz`);
      const label = parts.join(' + ') || 'Reward';
      return {
        message: `${label} from your referral settled. Spend it or save it on your referral dashboard.`,
        url: '/user/referrals',
      };
    },
  },
  'referral-milestone-hit': {
    displayName: 'Referral Milestone Reached',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => {
      const threshold = Number(details.threshold ?? 0).toLocaleString();
      const bonus = Number(details.bonusAmount ?? 0).toLocaleString();
      return {
        message: `You crossed the ${threshold} lifetime Blue Buzz milestone. +${bonus} bonus Blue Buzz is on the way.`,
        url: '/user/referrals',
      };
    },
  },
  'referral-token-expiring': {
    displayName: 'Referral Tokens Expiring Soon',
    category: NotificationCategory.Buzz,
    prepareMessage: ({ details }) => {
      const tokens = Number(details.tokens ?? 0);
      return {
        message: `${tokens} referral token${
          tokens === 1 ? '' : 's'
        } will expire within 7 days. Redeem them for Membership perks before they lapse.`,
        url: '/user/referrals',
      };
    },
  },
  'referral-welcome-bonus': {
    displayName: 'Welcome Bonus from Referral',
    category: NotificationCategory.Buzz,
    toggleable: false,
    prepareMessage: ({ details }) => {
      const blueBuzz = Number(details.blueBuzz ?? 0).toLocaleString();
      return {
        message: `Thanks for subscribing through a referral. ${blueBuzz} Blue Buzz has been added to your account.`,
        url: '/user/buzz-dashboard',
      };
    },
  },
});

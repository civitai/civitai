import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

/**
 * `app-buzz-refund` — a moderator refunded Buzz a user spent in an App (`/api/mod/apps/refund-workflows`).
 *
 * 🔴 THE REASON IS A FIXED SENTENCE, NEVER THE MODERATOR'S TEXT. A notification is a copy the
 * notifications service stores and may push to a device, and nothing retracts it. The free-text
 * reason a moderator types is for the audit row and the feedback triage note, where moderators read
 * it; it is written for them, not for the user.
 */
export const APP_BUZZ_REFUND_TYPE = 'app-buzz-refund';

export const APP_BUZZ_REFUND_REASON =
  'A generation you paid for was not delivered because of a problem on our side.';

export type AppBuzzRefundDetails = {
  amount: number;
  /** The app's name when every refunded generation ran in one app. */
  appName: string | null;
  /** How many apps the refunded generations ran in. */
  appCount: number;
};

export function appBuzzRefundMessage(details: Partial<AppBuzzRefundDetails>): string {
  const amount =
    typeof details.amount === 'number' && Number.isFinite(details.amount)
      ? `${details.amount.toLocaleString('en-US')} Buzz`
      : 'Buzz';
  const where = details.appName
    ? ` for "${details.appName}"`
    : typeof details.appCount === 'number' && details.appCount > 1
    ? ` for ${details.appCount} apps`
    : '';
  return `Refunded ${amount}${where}. ${APP_BUZZ_REFUND_REASON}`;
}

export const appBuzzRefundNotifications = createNotificationProcessor({
  [APP_BUZZ_REFUND_TYPE]: {
    displayName: 'App Buzz refunded',
    category: NotificationCategory.Buzz,
    // Money came back to the account; like a confirmed deposit, that is not something to opt out of.
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: appBuzzRefundMessage(details as Partial<AppBuzzRefundDetails>),
      url: '/user/transactions',
    }),
  },
});

import { describe, expect, it } from 'vitest';
import {
  APP_BUZZ_REFUND_TYPE,
  appBuzzRefundMessage,
  appBuzzRefundNotifications,
} from '~/server/notifications/app-buzz-refund.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

// The whole sentence is pinned: it is what a refunded user reads, and a fixed sentence is the point —
// a reworded one should fail here and be looked at.
const REASON = 'A generation you paid for was not delivered because of a problem on our side.';

describe('app-buzz-refund message', () => {
  it('names the amount and the one app', () => {
    expect(appBuzzRefundMessage({ amount: 1234, appName: 'Sample App', appCount: 1 })).toBe(
      `Refunded 1,234 Buzz for "Sample App". ${REASON}`
    );
  });

  it('counts the apps when there are several', () => {
    expect(appBuzzRefundMessage({ amount: 57, appName: null, appCount: 3 })).toBe(
      `Refunded 57 Buzz for 3 apps. ${REASON}`
    );
  });

  it('degrades on malformed details rather than printing "undefined"', () => {
    expect(appBuzzRefundMessage({})).toBe(`Refunded Buzz. ${REASON}`);
  });

  it('is registered, under Buzz, linking to the transaction history', () => {
    expect(notificationProcessors[APP_BUZZ_REFUND_TYPE]).toBe(
      appBuzzRefundNotifications[APP_BUZZ_REFUND_TYPE]
    );
    const processor = appBuzzRefundNotifications[APP_BUZZ_REFUND_TYPE];
    expect(processor.category).toBe('Buzz');
    expect(
      processor.prepareMessage({
        details: { amount: 9, appName: 'Sample App', appCount: 1 },
      } as never)
    ).toEqual({
      message: `Refunded 9 Buzz for "Sample App". ${REASON}`,
      url: '/user/transactions',
    });
  });
});

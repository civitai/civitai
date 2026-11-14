import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { StripeConnectStatus } from '~/server/common/enums';
// Module scope: see the note in user-payment-configuration.tipalti-status.test.ts.
import { updateByStripeConnectAccount } from '~/server/services/user-payment-configuration.service';
import type * as NotificationService from '~/server/services/notification.service';

const { mockCreateNotification } = vi.hoisted(() => ({ mockCreateNotification: vi.fn() }));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mockCreateNotification,
}));

const stored = { userId: 1, stripeAccountId: 'acct_1', stripeAccountStatus: 'PendingVerification' };

const account = (overrides: Partial<Stripe.Account>) =>
  ({
    id: 'acct_1',
    payouts_enabled: false,
    details_submitted: true,
    ...overrides,
  } as Stripe.Account);

describe('updateByStripeConnectAccount when the notification fails', () => {
  beforeEach(() => {
    mockCreateNotification.mockReset().mockRejectedValue(new Error('notifications down'));
    dbMock.dbWrite.userPaymentConfiguration.findUnique.mockReset().mockResolvedValue(stored);
    dbMock.dbWrite.userPaymentConfiguration.update
      .mockReset()
      .mockImplementation(async ({ data }) => ({ ...stored, ...data }));
  });

  // The row is written before the notification; the webhook must still see the write succeed.
  it.each([
    [
      'payments enabled',
      account({ payouts_enabled: true }),
      StripeConnectStatus.Approved,
      'creators-program-payments-enabled',
    ],
    [
      'rejected',
      account({
        requirements: { disabled_reason: 'rejected.other' } as Stripe.Account.Requirements,
      }),
      StripeConnectStatus.Rejected,
      'creators-program-rejected-stripe',
    ],
  ])('%s: still returns the written row', async (_label, stripeAccount, status, type) => {
    const updated = await updateByStripeConnectAccount({ stripeAccount });

    expect(updated).toMatchObject({ stripeAccountStatus: status });
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ type }));
  });
});

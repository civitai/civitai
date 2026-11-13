import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

/**
 * STRIPE_BILLING_PORTAL_CONFIGURATION_ID names the portal configuration every portal session
 * uses, so a card-only configuration can be switched on by env. Unset, Stripe's account default
 * applies and no `configuration` is sent.
 */

const { stripe } = vi.hoisted(() => ({
  stripe: {
    subscriptions: { list: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
  },
}));

vi.mock('~/server/utils/get-server-stripe', () => ({ getServerStripe: async () => stripe }));

import {
  createCancelSubscriptionSession,
  createManageSubscriptionSession,
  createSubscriptionChangeSession,
} from '~/server/services/stripe.service';

const sessions = {
  manage: () => createManageSubscriptionSession({ customerId: 'cus_1' }),
  change: () =>
    createSubscriptionChangeSession({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      subscriptionItemId: 'si_1',
      priceId: 'price_1',
    }),
  cancel: () => createCancelSubscriptionSession({ customerId: 'cus_1' }),
};

beforeEach(() => {
  vi.resetAllMocks();
  resetEnv();
  stripe.subscriptions.list.mockResolvedValue({ data: [{ id: 'sub_1', status: 'active' }] });
  stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://portal.stripe/x' });
});

describe('billing portal sessions use the configured portal configuration', () => {
  it.each(Object.entries(sessions))(
    '%s passes the configuration when it is set',
    async (_, open) => {
      setEnv({ STRIPE_BILLING_PORTAL_CONFIGURATION_ID: 'bpc_card_only' });

      await open();

      expect(stripe.billingPortal.sessions.create.mock.calls[0][0].configuration).toBe(
        'bpc_card_only'
      );
    }
  );

  it.each(Object.entries(sessions))(
    '%s sends no configuration when it is unset',
    async (_, open) => {
      await open();

      expect(stripe.billingPortal.sessions.create.mock.calls[0][0]).not.toHaveProperty(
        'configuration'
      );
    }
  );
});

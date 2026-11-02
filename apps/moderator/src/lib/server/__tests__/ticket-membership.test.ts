import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { membershipSectionFor } = await import('../tickets/membership');

const subscription = vi.fn();
const reads = { subscription: (...a: unknown[]) => subscription(...a) } as never;

const row = (over: Record<string, unknown> = {}) => ({
  productName: 'Gold',
  provider: 'Stripe',
  status: 'active',
  buzzType: null,
  cancelAtPeriodEnd: true,
  canceledAt: new Date('2026-10-02T00:00:00Z'),
  currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
  interval: 'month',
  unitAmount: 1000,
  currency: 'usd',
  ...over,
});

beforeEach(() => {
  subscription.mockReset().mockResolvedValue(row());
});

describe('membershipSectionFor', () => {
  it('reads the linked users current subscription', async () => {
    const res = await membershipSectionFor({ userId: 7 }, reads);
    expect(subscription).toHaveBeenCalledWith(7);
    expect(res).toEqual({
      status: 'ok',
      userId: 7,
      subscription: {
        productName: 'Gold',
        provider: 'Stripe',
        status: 'active',
        buzzType: null,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        interval: 'month',
        unitAmount: 1000,
        currency: 'usd',
      },
    });
  });

  it('carries no card price on a perks-only row, whatever list price it joins to', async () => {
    for (const buzzType of ['buzzPurchase', 'referral']) {
      subscription.mockResolvedValue(row({ buzzType }));
      const res = await membershipSectionFor({ userId: 7 }, reads);
      expect(res).toMatchObject({
        subscription: { buzzType, interval: null, unitAmount: null, currency: null },
      });
    }
    subscription.mockResolvedValue(row({ buzzType: 'yellow' }));
    expect(await membershipSectionFor({ userId: 7 }, reads)).toMatchObject({
      subscription: { interval: 'month', unitAmount: 1000, currency: 'usd' },
    });
  });

  it('says there is no subscription rather than failing', async () => {
    subscription.mockResolvedValue(null);
    expect(await membershipSectionFor({ userId: 7 }, reads)).toEqual({
      status: 'ok',
      userId: 7,
      subscription: null,
    });
  });

  it('carries only the allow-listed fields, whatever the row holds', async () => {
    subscription.mockResolvedValue(
      row({
        code: 'SECRET-CODE',
        membershipCode: 'SECRET-CODE',
        stripeCustomerId: 'cus_123',
        subscriptionId: 'sub_123',
        paymentMethod: { last4: '4242' },
      })
    );
    const json = JSON.stringify(await membershipSectionFor({ userId: 7 }, reads));
    for (const leak of ['SECRET-CODE', 'cus_123', 'sub_123', '4242']) {
      expect(json).not.toContain(leak);
    }
  });
});

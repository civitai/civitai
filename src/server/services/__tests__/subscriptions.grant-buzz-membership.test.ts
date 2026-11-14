import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import type * as Freshdesk from '~/server/integrations/freshdesk';
import type * as SubscriptionUtils from '~/server/utils/subscription.utils';

/**
 * The Knights gold shop sells the same perks-only month as `purchaseMembershipWithBuzz`, paid in gold. A retry of a
 * granted purchase has to answer `already`, never a refusal and never a second month.
 */

const { invalidateSubscriptionCaches, upsertContact, createBuzzTransaction, refundTransaction } =
  vi.hoisted(() => ({
    invalidateSubscriptionCaches: vi.fn(),
    upsertContact: vi.fn(),
    createBuzzTransaction: vi.fn(),
    refundTransaction: vi.fn(),
  }));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBuzzTransaction,
  refundTransaction,
}));
vi.mock('~/server/integrations/freshdesk', async (importOriginal) => ({
  ...(await importOriginal<typeof Freshdesk>()),
  upsertContact,
}));
vi.mock('~/server/utils/subscription.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof SubscriptionUtils>()),
  invalidateSubscriptionCaches,
}));

import {
  BuzzMembershipRefusedError,
  grantBuzzPurchaseMembership,
  purchaseMembershipWithBuzz,
} from '~/server/services/subscriptions.service';

const USER_ID = 77;
const price = (over: Record<string, unknown> = {}, productOver: Record<string, unknown> = {}) => ({
  id: 'civitai-buzz-silver-monthly',
  interval: 'month',
  intervalCount: 1,
  unitAmount: 2500,
  product: {
    id: 'civitai-buzz-silver',
    name: 'Silver',
    metadata: { tier: 'silver', level: '2', buzzPurchase: true, monthlyBuzz: 0 },
    provider: 'Civitai',
    active: true,
    ...productOver,
  },
  ...over,
});

const goldPrice = () =>
  price(
    { id: 'civitai-buzz-gold-monthly', unitAmount: 5000 },
    {
      id: 'civitai-buzz-gold',
      name: 'Gold',
      metadata: { tier: 'gold', level: '3', buzzPurchase: true, monthlyBuzz: 0 },
    }
  );
/** Answers like the catalog: the price whose product tier the lookup asks for, if the lookup is the monthly Buzz one. */
const catalogLookup = async ({ where }: { where: Record<string, any> }) => {
  if (where.id) return where.id === 'p' ? price() : null;
  const tier = (where.product?.AND ?? []).find((c: any) => c.metadata?.path?.[0] === 'tier')
    ?.metadata?.equals;
  return tier === 'silver' ? price() : tier === 'gold' ? goldPrice() : null;
};

type Row = {
  id: string;
  metadata: { grantKeys?: string[]; [flag: string]: unknown };
  currentPeriodEnd: Date;
};
let row: Row | null;
const subscription = dbMock.dbWrite.customerSubscription;
// A client apart from `dbWrite`, so a call that should run inside the transaction cannot pass on the outer one.
let tx: {
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
  customerSubscription: typeof subscription;
};

beforeEach(() => {
  resetSharedMocks();
  vi.clearAllMocks();
  row = null;
  tx = {
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    customerSubscription: subscription,
  };
  dbMock.dbWrite.$transaction.mockImplementation((async (run: (client: unknown) => unknown) =>
    run(tx)) as never);
  dbMock.dbWrite.price.findFirst.mockImplementation(catalogLookup as never);
  createBuzzTransaction.mockResolvedValue({ transactionId: 'tx-1' });
  refundTransaction.mockResolvedValue(undefined);
  dbMock.dbWrite.user.findFirst.mockResolvedValue({
    id: USER_ID,
    username: 'knight',
    email: 'knight@example.com',
  } as never);
  upsertContact.mockResolvedValue(undefined);
  subscription.findUnique.mockImplementation((async () => row) as never);
  // a live membership blocks a second month, the way the real conflict query does
  subscription.findFirst.mockImplementation((async () =>
    row && row.currentPeriodEnd > new Date() ? { id: row.id } : null) as never);
  subscription.upsert.mockImplementation((async ({
    create,
    update,
  }: {
    create: Row;
    update: Row;
  }) => {
    row = { ...(row ? update : create), id: row?.id ?? create.id } as Row;
    return row;
  }) as never);
});

describe('grantBuzzPurchaseMembership', () => {
  it('grants one month in the Buzz-purchase slot, renewing never, and delivers the monthly badge', async () => {
    const result = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });

    expect(result.outcome).toBe('granted');
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
    const { where, create } = subscription.upsert.mock.calls[0][0] as never as {
      where: unknown;
      create: Record<string, unknown>;
    };
    expect(where).toEqual({ userId_buzzType: { userId: USER_ID, buzzType: 'buzzPurchase' } });
    expect(create).toMatchObject({
      productId: 'civitai-buzz-silver',
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER_ID);
  });

  it('ends a 7-day grant seven days out and a grant without days one month out', async () => {
    const before = Date.now();
    const week = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      days: 7,
      idempotencyKey: 'knights-shop:key-week',
    });
    const weekDays = (week.currentPeriodEnd.getTime() - before) / 86_400_000;
    expect(weekDays).toBeGreaterThan(6.99);
    expect(weekDays).toBeLessThan(7.01);

    row = null;
    const month = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-month',
    });
    const monthDays = (month.currentPeriodEnd.getTime() - before) / 86_400_000;
    expect(monthDays).toBeGreaterThanOrEqual(28);
    expect(monthDays).toBeLessThanOrEqual(31.01);
  });

  it('still refuses a second grant while a 7-day membership is running', async () => {
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      days: 7,
      idempotencyKey: 'knights-shop:key-1',
    });
    await expect(
      grantBuzzPurchaseMembership({
        userId: USER_ID,
        tier: 'silver',
        days: 7,
        idempotencyKey: 'knights-shop:key-2',
      })
    ).rejects.toMatchObject({ reason: 'active-membership' });
  });

  it('answers already on a retry of the same key and grants no second month', async () => {
    const first = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    const again = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });

    expect(again.outcome).toBe('already');
    expect(again.currentPeriodEnd).toEqual(first.currentPeriodEnd);
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
    expect(invalidateSubscriptionCaches).toHaveBeenCalledTimes(2);
  });

  it('answers already even when the product has since been withdrawn', async () => {
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    dbMock.dbWrite.price.findFirst.mockResolvedValue(null as never);

    const again = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    expect(again.outcome).toBe('already');
  });

  it('answers already for a replay that lost the race inside the transaction', async () => {
    // the replay check outside the transaction saw nothing; the first caller commits before this one's lock
    subscription.findUnique
      .mockImplementationOnce((async () => null) as never)
      .mockImplementationOnce((async () => ({
        metadata: { grantKeys: ['knights-shop:key-1'] },
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      })) as never);

    const result = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    expect(result.outcome).toBe('already');
    expect(subscription.upsert).not.toHaveBeenCalled();
  });

  it('refuses a different key while a month is running, with a typed refusal', async () => {
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });

    await expect(
      grantBuzzPurchaseMembership({
        userId: USER_ID,
        tier: 'silver',
        idempotencyKey: 'knights-shop:key-2',
      })
    ).rejects.toMatchObject({ name: 'BuzzMembershipRefusedError', reason: 'active-membership' });
    expect(subscription.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps earlier keys when a lapsed row is bought again, so an old retry still answers already', async () => {
    row = {
      id: 'old',
      metadata: { grantKeys: ['knights-shop:key-0'] },
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
    };
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    const old = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-0',
    });
    expect(old.outcome).toBe('already');
  });

  it.each([
    ['no such product', null, 'unavailable'],
    ['a multi-month price', price({ intervalCount: 3 }), 'not-monthly'],
    ['a cash product', price({}, { provider: 'Stripe' }), 'unavailable'],
    [
      'a product that is not Buzz-purchasable',
      price({}, { metadata: { tier: 'silver' } }),
      'unavailable',
    ],
    [
      'a free tier',
      price({}, { metadata: { tier: 'free', buzzPurchase: true, monthlyBuzz: 0 } }),
      'unavailable',
    ],
    [
      'a founder tier',
      price({}, { metadata: { tier: 'founder', buzzPurchase: true, monthlyBuzz: 0 } }),
      'unavailable',
    ],
  ])('refuses %s as a final refusal', async (_name, found, reason) => {
    dbMock.dbWrite.price.findFirst.mockResolvedValue(found as never);

    const error = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuzzMembershipRefusedError);
    expect((error as BuzzMembershipRefusedError).reason).toBe(reason);
    expect(subscription.upsert).not.toHaveBeenCalled();
  });

  it('keeps an infrastructure failure retryable: not a refusal, and the key is not recorded', async () => {
    subscription.upsert.mockRejectedValueOnce(new Error('connection reset'));

    const error = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BuzzMembershipRefusedError);
  });

  it('does not fail a committed grant when the support-desk sync fails', async () => {
    upsertContact.mockRejectedValue(new Error('freshdesk down'));
    const result = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    expect(result.outcome).toBe('granted');
  });
});

describe('the product a tier sells', () => {
  it('looks up the monthly Buzz-purchase product of the requested tier, so gold is not sold as silver', async () => {
    const result = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'gold',
      idempotencyKey: 'knights-shop:key-1',
    });

    expect(result.outcome).toBe('granted');
    expect(dbMock.dbWrite.price.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          active: true,
          interval: 'month',
          intervalCount: 1,
          product: expect.objectContaining({
            active: true,
            provider: 'Civitai',
            AND: [
              { metadata: { path: ['buzzPurchase'], equals: true } },
              { metadata: { path: ['tier'], equals: 'gold' } },
            ],
          }),
        }),
      })
    );
    expect(subscription.upsert.mock.calls[0][0]).toMatchObject({
      create: { productId: 'civitai-buzz-gold', priceId: 'civitai-buzz-gold-monthly' },
    });
  });

  it('refuses a tier with no product rather than falling back to another', async () => {
    const error = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'bronze',
      idempotencyKey: 'knights-shop:key-1',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BuzzMembershipRefusedError);
    expect(subscription.upsert).not.toHaveBeenCalled();
  });
});

describe('a Buzz purchase and a gold grant share one slot', () => {
  const lapse = () => {
    if (row) row.currentPeriodEnd = new Date(Date.now() - 86_400_000);
  };

  it('keeps the gold grant keys through a Buzz purchase, so the old key still answers already', async () => {
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-K',
    });
    lapse();
    await purchaseMembershipWithBuzz({ userId: USER_ID, priceId: 'p', buzzType: 'green' });
    expect(row?.metadata.grantKeys).toEqual(['knights-shop:key-K']);
    lapse();

    const retry = await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-K',
    });
    expect(retry.outcome).toBe('already');
    expect(subscription.upsert).toHaveBeenCalledTimes(2);
  });

  it('takes the user row lock for a keyless call too, before the conflict check', async () => {
    const queries: string[] = [];
    tx.$queryRaw.mockImplementation((async (strings: TemplateStringsArray) => {
      queries.push(strings.join('?'));
      return [];
    }) as never);
    subscription.findFirst.mockImplementation((async () => {
      queries.push('conflict-check');
      return null;
    }) as never);

    await grantBuzzPurchaseMembership({ userId: USER_ID, tier: 'silver' });
    await purchaseMembershipWithBuzz({ userId: USER_ID, priceId: 'p', buzzType: 'green' });

    expect(queries).toHaveLength(4);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    for (const at of [0, 2]) {
      expect(queries[at]).toContain('FOR UPDATE');
      expect(queries[at + 1]).toBe('conflict-check');
    }
  });

  it('does not refund a purchase that was granted', async () => {
    await purchaseMembershipWithBuzz({ userId: USER_ID, priceId: 'p', buzzType: 'green' });

    expect(subscription.upsert).toHaveBeenCalledTimes(1);
    expect(refundTransaction).not.toHaveBeenCalled();
  });

  it('carries only the stored keys into a new month, not other flags on the lapsed row', async () => {
    row = {
      id: 'old',
      metadata: { grantKeys: ['knights-shop:key-0'], renewalEmailSent: true },
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
    };
    await grantBuzzPurchaseMembership({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });

    expect(row?.metadata).toEqual({ grantKeys: ['knights-shop:key-0', 'knights-shop:key-1'] });
  });

  it('leaves a keyless month with no flags from the lapsed row either', async () => {
    row = {
      id: 'old',
      metadata: { renewalEmailSent: true },
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
    };
    await purchaseMembershipWithBuzz({ userId: USER_ID, priceId: 'p', buzzType: 'green' });

    expect(row?.metadata).toEqual({});
  });

  it('refunds the Buzz when the commit finds a concurrent membership', async () => {
    subscription.findFirst.mockImplementation((async () => ({ id: 'other' })) as never);

    await expect(
      purchaseMembershipWithBuzz({ userId: USER_ID, priceId: 'p', buzzType: 'green' })
    ).rejects.toMatchObject({ name: 'BuzzMembershipRefusedError', reason: 'active-membership' });
    expect(refundTransaction).toHaveBeenCalledTimes(1);
    expect(refundTransaction).toHaveBeenCalledWith('tx-1', expect.any(String));
    expect(subscription.upsert).not.toHaveBeenCalled();
  });
});

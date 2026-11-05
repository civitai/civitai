import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import type * as Freshdesk from '~/server/integrations/freshdesk';
import type * as SubscriptionUtils from '~/server/utils/subscription.utils';

/**
 * The Knights gold shop sells the same perks-only month as `purchaseMembershipWithBuzz`, paid in gold. A retry of a
 * granted purchase has to answer `already`, never a refusal and never a second month.
 */

const { invalidateSubscriptionCaches, upsertContact } = vi.hoisted(() => ({
  invalidateSubscriptionCaches: vi.fn(),
  upsertContact: vi.fn(),
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
  grantBuzzPurchaseMembershipMonth,
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

type Row = { id: string; metadata: { grantKeys?: string[] }; currentPeriodEnd: Date };
let row: Row | null;
const subscription = dbMock.dbWrite.customerSubscription;

beforeEach(() => {
  resetSharedMocks();
  vi.clearAllMocks();
  row = null;
  dbMock.dbWrite.price.findFirst.mockResolvedValue(price() as never);
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

describe('grantBuzzPurchaseMembershipMonth', () => {
  it('grants one month in the Buzz-purchase slot, renewing never, and delivers the badge in the same transaction', async () => {
    const result = await grantBuzzPurchaseMembershipMonth({
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
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(invalidateSubscriptionCaches).toHaveBeenCalledWith(USER_ID);
  });

  it('answers already on a retry of the same key and grants no second month', async () => {
    const first = await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    const again = await grantBuzzPurchaseMembershipMonth({
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
    await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    dbMock.dbWrite.price.findFirst.mockResolvedValue(null as never);

    const again = await grantBuzzPurchaseMembershipMonth({
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

    const result = await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    expect(result.outcome).toBe('already');
    expect(subscription.upsert).not.toHaveBeenCalled();
  });

  it('refuses a different key while a month is running, with a typed refusal', async () => {
    await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });

    await expect(
      grantBuzzPurchaseMembershipMonth({
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
    await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    const old = await grantBuzzPurchaseMembershipMonth({
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
  ])('refuses %s as a final refusal', async (_name, found, reason) => {
    dbMock.dbWrite.price.findFirst.mockResolvedValue(found as never);

    const error = await grantBuzzPurchaseMembershipMonth({
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

    const error = await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BuzzMembershipRefusedError);
    expect(row).toBeNull();
  });

  it('does not fail a committed grant when the support-desk sync fails', async () => {
    upsertContact.mockRejectedValue(new Error('freshdesk down'));
    const result = await grantBuzzPurchaseMembershipMonth({
      userId: USER_ID,
      tier: 'silver',
      idempotencyKey: 'knights-shop:key-1',
    });
    expect(result.outcome).toBe('granted');
  });
});

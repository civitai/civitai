import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import {
  getAllUserSubscriptions,
  getCapTier,
  getHighestPaidTierSubscription,
  getHighestTierSubscription,
} from '~/server/services/subscriptions.service';

/**
 * What every reader of a user's subscriptions gets, pinned row by row. `getAllUserSubscriptions`
 * shares its row mapping with the batched `getCapTiers`, so a change to the mapping for one
 * changes it for billing, membership and monetization caps alike: these expectations are written
 * out by hand, not derived from the code under test.
 */

const findMany = dbMock.dbWrite.customerSubscription.findMany;

const row = (
  id: string,
  {
    status = 'active',
    tier,
    metadata = {},
    productMeta = {},
    unitAmount = 1000,
  }: {
    status?: string;
    tier?: string;
    metadata?: Record<string, unknown>;
    productMeta?: Record<string, unknown>;
    unitAmount?: number | null;
  }
) => ({
  id,
  status,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  currentPeriodStart: new Date('2026-10-01'),
  currentPeriodEnd: new Date('2026-11-01'),
  createdAt: new Date('2026-10-01'),
  endedAt: null,
  metadata,
  buzzType: 'yellow',
  product: {
    id: `prod-${id}`,
    name: id,
    description: null,
    metadata: { ...(tier ? { tier } : {}), ...productMeta },
    provider: 'Civitai',
    active: true,
  },
  price: {
    id: `price-${id}`,
    unitAmount,
    interval: 'month',
    intervalCount: 1,
    currency: 'usd',
    active: true,
  },
});

const ROWS = [
  row('active-gold', { tier: 'gold' }),
  row('trialing-silver', { status: 'trialing', tier: 'silver' }),
  row('incomplete-gold', { status: 'incomplete', tier: 'gold' }),
  row('free-tier', { tier: 'free' }),
  row('renewal-notified', { tier: 'gold', metadata: { renewalEmailSent: true } }),
  row('buzz-bronze', { tier: 'bronze', productMeta: { buzzPurchase: true } }),
  row('no-amount', { tier: 'bronze', unitAmount: null }),
];

beforeEach(() => {
  resetSharedMocks();
  findMany.mockResolvedValue(ROWS as never);
});

describe('getAllUserSubscriptions', () => {
  it('asks only for subscriptions that are still live', async () => {
    await getAllUserSubscriptions(7);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: {
        userId: 7,
        status: { notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] },
      },
    });
  });

  it('maps every row as written, and drops a renewal-notified one', async () => {
    const subs = await getAllUserSubscriptions(7);
    expect(
      subs.map((s) => ({
        id: s.id,
        tier: s.tier,
        isBadState: s.isBadState,
        unitAmount: s.price.unitAmount,
        interval: s.price.interval,
        buzzPurchase: !!s.productMeta.buzzPurchase,
      }))
    ).toEqual([
      {
        id: 'active-gold',
        tier: 'gold',
        isBadState: false,
        unitAmount: 1000,
        interval: 'month',
        buzzPurchase: false,
      },
      {
        id: 'trialing-silver',
        tier: 'silver',
        isBadState: false,
        unitAmount: 1000,
        interval: 'month',
        buzzPurchase: false,
      },
      {
        id: 'incomplete-gold',
        tier: 'gold',
        isBadState: true,
        unitAmount: 1000,
        interval: 'month',
        buzzPurchase: false,
      },
      {
        id: 'free-tier',
        tier: 'free',
        isBadState: false,
        unitAmount: 1000,
        interval: 'month',
        buzzPurchase: false,
      },
      {
        id: 'buzz-bronze',
        tier: 'bronze',
        isBadState: false,
        unitAmount: 1000,
        interval: 'month',
        buzzPurchase: true,
      },
      {
        id: 'no-amount',
        tier: 'bronze',
        isBadState: false,
        unitAmount: 0,
        interval: 'month',
        buzzPurchase: false,
      },
    ]);
  });

  it('asks for exactly the columns its readers use', async () => {
    await getAllUserSubscriptions(7);
    expect((findMany.mock.calls[0][0] as { select: unknown }).select).toEqual({
      id: true,
      status: true,
      cancelAtPeriodEnd: true,
      cancelAt: true,
      canceledAt: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
      createdAt: true,
      endedAt: true,
      metadata: true,
      buzzType: true,
      product: {
        select: {
          id: true,
          name: true,
          description: true,
          metadata: true,
          provider: true,
          active: true,
        },
      },
      price: {
        select: {
          id: true,
          unitAmount: true,
          interval: true,
          intervalCount: true,
          currency: true,
          active: true,
        },
      },
    });
  });

  it('keeps every other column of the row as the database returned it', async () => {
    const [first] = await getAllUserSubscriptions(7);
    const { price: _price, ...rest } = ROWS[0];
    expect(first).toMatchObject(rest);
    expect(first.price).toMatchObject({ id: 'price-active-gold', currency: 'usd' });
  });

  it('answers the tier helpers from those rows', async () => {
    // The bad-state gold is the highest of all, but buys no cap.
    expect((await getHighestTierSubscription(7))?.id).toBe('active-gold');
    expect(await getCapTier(7)).toBe('gold');
    // Gold first among paid ones; the Buzz-bought bronze never counts here.
    expect((await getHighestPaidTierSubscription(7))?.id).toBe('active-gold');
  });

  it('gives no cap from a bad-state subscription alone', async () => {
    findMany.mockResolvedValue([
      row('incomplete-gold', { status: 'incomplete', tier: 'gold' }),
    ] as never);
    expect(await getCapTier(7)).toBeNull();
    expect((await getHighestTierSubscription(7))?.id).toBe('incomplete-gold');
  });
});

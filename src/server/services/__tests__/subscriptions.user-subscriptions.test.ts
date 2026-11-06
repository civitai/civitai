import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import {
  getAllUserSubscriptions,
  getCapTier,
  getHighestPaidTierSubscription,
  getHighestTierSubscription,
  getUserMembershipHistory,
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

describe('getUserMembershipHistory', () => {
  const historyFindMany = dbMock.dbRead.customerSubscriptionHistory.findMany;
  const liveFindMany = dbMock.dbRead.customerSubscription.findMany;
  const productFindMany = dbMock.dbRead.product.findMany;

  const historyRow = (
    id: number,
    productId: string,
    {
      status = 'active',
      closedReason = null,
      metadata = {},
      buzzType = 'yellow',
      currentPeriodEnd = new Date('2026-11-01'),
    }: {
      status?: string;
      closedReason?: string | null;
      metadata?: Record<string, unknown>;
      buzzType?: string;
      currentPeriodEnd?: Date;
    } = {}
  ) => ({
    id,
    subscriptionId: `sub-${id}`,
    buzzType,
    productId,
    status,
    metadata,
    cancelAtPeriodEnd: false,
    cancelAt: null,
    canceledAt: null,
    startedAt: new Date('2026-01-01'),
    currentPeriodStart: new Date('2026-10-01'),
    currentPeriodEnd,
    endedAt: closedReason ? new Date('2026-09-01') : null,
    closedReason,
  });

  beforeEach(() => {
    productFindMany.mockResolvedValue([
      { id: 'prod-gold', name: 'Gold', metadata: { tier: 'gold' }, provider: 'Civitai' },
      { id: 'prod-silver', name: 'Silver', metadata: { tier: 'silver' }, provider: 'Stripe' },
    ] as never);
  });

  it("lists the caller's past memberships that the live table no longer holds", async () => {
    historyFindMany.mockResolvedValue([
      historyRow(1, 'prod-silver', { closedReason: 'replaced', buzzType: 'green' }),
      historyRow(2, 'prod-gold', {
        metadata: { tokens: [{ id: 't1', tier: 'gold', status: 'claimed', buzzAmount: 50000 }] },
      }),
    ] as never);
    liveFindMany.mockResolvedValue([row('sub-2', { tier: 'gold' })] as never);

    const history = await getUserMembershipHistory({ userId: 7 });

    expect(historyFindMany.mock.calls[0][0]?.where).toEqual({ userId: 7 });
    expect(liveFindMany.mock.calls[0][0]?.where).toEqual({ userId: 7 });
    // The open (current) membership first, then the replaced one; no duplicate of the live row.
    expect(history.map((membership) => membership.id)).toEqual(['history-2', 'history-1']);
    expect(history[0]).toMatchObject({
      tier: 'gold',
      paymentMethod: 'prepaid',
      prepaidTokens: { total: 1, claimed: 1 },
    });
    expect(history[1]).toMatchObject({
      tier: 'silver',
      paymentMethod: 'card',
      closedReason: 'replaced',
    });
    for (const membership of history) expect(membership).not.toHaveProperty('metadata');
  });

  it('lists ended memberships newest first', async () => {
    historyFindMany.mockResolvedValue([
      historyRow(1, 'prod-silver', {
        closedReason: 'replaced',
        currentPeriodEnd: new Date('2025-06-01'),
      }),
      historyRow(2, 'prod-silver', {
        closedReason: 'removed',
        currentPeriodEnd: new Date('2026-03-01'),
      }),
    ] as never);
    liveFindMany.mockResolvedValue([] as never);

    const history = await getUserMembershipHistory({ userId: 7 });

    expect(history.map((membership) => membership.id)).toEqual(['history-2', 'history-1']);
  });

  it('falls back to a live row with no open history row, described from its own product', async () => {
    productFindMany.mockResolvedValue([
      {
        id: 'prod-live-gold',
        name: 'Gold Membership',
        metadata: { tier: 'gold' },
        provider: 'Stripe',
      },
      { id: 'prod-silver', name: 'Silver', metadata: { tier: 'silver' }, provider: 'Stripe' },
    ] as never);
    historyFindMany.mockResolvedValue([
      historyRow(1, 'prod-silver', { closedReason: 'removed' }),
    ] as never);
    liveFindMany.mockResolvedValue([row('live-gold', { tier: 'gold' })] as never);

    const history = await getUserMembershipHistory({ userId: 7 });

    expect(history.map((membership) => membership.id)).toEqual(['live-live-gold', 'history-1']);
    expect(history[0]).toMatchObject({
      productName: 'Gold Membership',
      tier: 'gold',
      paymentMethod: 'card',
      startedAt: new Date('2026-10-01'),
    });
  });

  it('still shows a live subscription when its slot holds a stale open row for another one', async () => {
    historyFindMany.mockResolvedValue([historyRow(1, 'prod-silver')] as never);
    liveFindMany.mockResolvedValue([row('sub-new', { tier: 'gold' })] as never);

    const history = await getUserMembershipHistory({ userId: 7 });

    expect(history.map((membership) => membership.id).sort()).toEqual([
      'history-1',
      'live-sub-new',
    ]);
  });

  it('shows the live rows when the history table does not exist yet', async () => {
    historyFindMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing table', {
        code: 'P2021',
        clientVersion: 'test',
      })
    );
    liveFindMany.mockResolvedValue([row('sub-2', { tier: 'gold' })] as never);

    const history = await getUserMembershipHistory({ userId: 7 });

    expect(history.map((membership) => membership.id)).toEqual(['live-sub-2']);
  });

  it('does not hide any other database error', async () => {
    historyFindMany.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('timeout', { code: 'P1008', clientVersion: 'test' })
    );
    liveFindMany.mockResolvedValue([] as never);

    await expect(getUserMembershipHistory({ userId: 7 })).rejects.toThrow('timeout');
  });
});

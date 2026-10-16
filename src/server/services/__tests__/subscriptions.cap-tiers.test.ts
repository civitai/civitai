import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { getCapTier, getCapTiers } from '~/server/services/subscriptions.service';

/**
 * `getCapTiers` is `getCapTier` for a page of creators in one query. Each user's answer must be
 * the one `getCapTier` gives for the same rows: a bad-state or renewal-notified subscription
 * buys no cap, and the highest good-standing tier wins.
 */

const findMany = dbMock.dbWrite.customerSubscription.findMany;

const subscription = (
  userId: number,
  tier: string,
  overrides: { status?: string; metadata?: Record<string, unknown> } = {}
) => ({
  userId,
  id: `sub-${userId}-${tier}-${overrides.status ?? 'active'}`,
  status: overrides.status ?? 'active',
  cancelAtPeriodEnd: false,
  cancelAt: null,
  canceledAt: null,
  currentPeriodStart: new Date('2026-10-01'),
  currentPeriodEnd: new Date('2026-11-01'),
  createdAt: new Date('2026-10-01'),
  endedAt: null,
  metadata: overrides.metadata ?? {},
  buzzType: 'yellow',
  product: {
    id: `prod-${tier}`,
    name: tier,
    description: null,
    metadata: { tier },
    provider: 'Civitai',
    active: true,
  },
  price: {
    id: `price-${tier}`,
    unitAmount: 1000,
    interval: 'month',
    intervalCount: 1,
    currency: 'usd',
    active: true,
  },
});

const rows = [
  // Two good-standing subscriptions: the higher tier wins.
  subscription(1, 'bronze'),
  subscription(1, 'gold'),
  // Gold mid-failed-payment buys no cap; silver in good standing does.
  subscription(2, 'gold', { status: 'incomplete' }),
  subscription(2, 'silver'),
  // A renewal-notified subscription no longer counts at all.
  subscription(3, 'gold', { metadata: { renewalEmailSent: true } }),
  // The higher tier read first: the answer is the highest, not the last row seen.
  subscription(5, 'gold'),
  subscription(5, 'bronze'),
];

beforeEach(() => {
  resetSharedMocks();
  findMany.mockImplementation(((args: { where: { userId: number | { in: number[] } } }) => {
    const ids = typeof args.where.userId === 'number' ? [args.where.userId] : args.where.userId.in;
    return Promise.resolve(
      rows
        .filter((row) => ids.includes(row.userId))
        .map((row) => (typeof args.where.userId === 'number' ? { ...row, userId: undefined } : row))
    );
  }) as never);
});

describe('getCapTiers', () => {
  it('gives every user the tier getCapTier gives them, in one query', async () => {
    const tiers = await getCapTiers([1, 2, 3, 4, 5, 2]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(tiers).toEqual(
      new Map([
        [1, 'gold'],
        [2, 'silver'],
        [3, null],
        [4, null],
        [5, 'gold'],
      ])
    );
    for (const userId of [1, 2, 3, 4, 5]) expect(await getCapTier(userId)).toBe(tiers.get(userId));
  });

  it('asks for the same subscription statuses as getCapTier', async () => {
    await getCapTiers([1]);
    await getCapTier(1);
    const [batched, single] = findMany.mock.calls.map(
      (call) => (call[0] as { where: { status: unknown } }).where.status
    );
    expect(batched).toEqual(single);
    expect(single).toEqual({ notIn: ['canceled', 'incomplete_expired', 'past_due', 'unpaid'] });
  });

  it('reads nothing for no users', async () => {
    await expect(getCapTiers([])).resolves.toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
  });

  it('selects the owner of each row, so rows key to their user', async () => {
    await getCapTiers([1, 2]);
    expect(findMany.mock.calls[0][0]).toMatchObject({ select: { userId: true } });
  });
});

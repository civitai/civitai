import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindMany: vi.fn(),
    shopItemCount: vi.fn(),
  },
}));

vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

import { getReviewQueueSchema } from '~/server/schema/creator-shop.schema';
import { getCreatorShopReviewQueue } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.count.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemCount as (...a: unknown[]) => unknown)(...args)
);

const itemRow = (id: number) => ({ id, title: `Item ${id}`, cosmeticId: id * 10, meta: {} });

const baseInput = getReviewQueueSchema.parse({});

const findManyArg = () =>
  mocks.shopItemFindMany.mock.calls[0][0] as {
    where: Record<string, unknown>;
    take?: number;
    skip?: number;
    orderBy: { createdAt?: 'asc' | 'desc'; id?: 'asc' | 'desc' }[];
  };

describe('getCreatorShopReviewQueue', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindMany.mockResolvedValue([]);
    mocks.shopItemCount.mockResolvedValue(0);
  });

  it('defaults to oldest-first, the triage order', () => {
    // Guards the default at the schema, which is where the queue's order is
    // decided for any caller that omits `sort`.
    expect(baseInput.sort).toBe('oldest');
  });

  it('orders oldest-first with an id tiebreak', async () => {
    await getCreatorShopReviewQueue({ ...baseInput, sort: 'oldest' });
    expect(findManyArg().orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('orders newest-first with an id tiebreak', async () => {
    await getCreatorShopReviewQueue({ ...baseInput, sort: 'newest' });
    expect(findManyArg().orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('pages by skip/take and reports the page count from the total', async () => {
    mocks.shopItemFindMany.mockResolvedValue([itemRow(5), itemRow(6)]);
    mocks.shopItemCount.mockResolvedValue(7);

    const { items, totalItems, totalPages, currentPage } = await getCreatorShopReviewQueue({
      ...baseInput,
      limit: 2,
      page: 3,
    });

    const { take, skip } = findManyArg();
    expect({ take, skip }).toEqual({ take: 2, skip: 4 });
    expect(items.map((i) => i.id)).toEqual([5, 6]);
    expect({ totalItems, totalPages, currentPage }).toEqual({
      totalItems: 7,
      totalPages: 4,
      currentPage: 3,
    });
  });

  it('counts the same rows it lists', async () => {
    // A count taken over a wider filter than the list inflates totalPages, and
    // the extra pages come back empty.
    await getCreatorShopReviewQueue({
      ...baseInput,
      status: 'Published',
      userId: 42,
      cosmeticTypes: ['Badge'],
    });
    const { where } = findManyArg();
    expect(mocks.shopItemCount).toHaveBeenCalledWith({ where });
  });
});

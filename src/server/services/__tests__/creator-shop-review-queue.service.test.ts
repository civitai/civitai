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

  // A mystery box listing has no cosmetic and a moderator lister, the pack arm's exact shape.
  it('keeps mystery box listings out of the pack arm', async () => {
    await getCreatorShopReviewQueue(baseInput);
    const { where } = findManyArg();
    const arms = (where.OR ?? []) as Record<string, unknown>[];
    const packArm = arms.find((arm) => 'cosmeticId' in arm && arm.cosmeticId === null);
    expect(packArm).toBeDefined();
    expect(packArm).toMatchObject({ itemDefinitionId: null });
  });

  const armsOf = () => (findManyArg().where.OR ?? []) as Record<string, unknown>[];
  const mysteryArm = () =>
    armsOf().find((arm) => 'itemDefinition' in arm && !('cosmeticId' in arm));

  it("matches a creator's mystery packs by their box's seller, and only them under the filter", async () => {
    await getCreatorShopReviewQueue({ ...baseInput, cosmeticTypes: ['MysteryPack'], userId: 42 });
    expect(armsOf()).toEqual([
      {
        itemDefinition: { sellerId: 42 },
        status: { not: 'Archived' },
      },
    ]);
  });

  it('leaves mystery packs out when another type is picked', async () => {
    await getCreatorShopReviewQueue({ ...baseInput, cosmeticTypes: ['Pack', 'Badge'] });
    expect(mysteryArm()).toBeUndefined();
    expect(armsOf()).toHaveLength(2);
  });

  it('includes mystery packs in the unfiltered view', async () => {
    await getCreatorShopReviewQueue(baseInput);
    expect(mysteryArm()).toEqual({
      itemDefinition: { sellerId: { not: null } },
      status: { not: 'Archived' },
    });
    expect(armsOf()).toHaveLength(3);
  });

  it("filters mystery packs by their creator's username", async () => {
    await getCreatorShopReviewQueue({
      ...baseInput,
      cosmeticTypes: ['MysteryPack'],
      username: 'ann',
    });
    expect(mysteryArm()).toMatchObject({
      addedBy: { username: { contains: 'ann', mode: 'insensitive' } },
    });
  });

  it('shows a mystery pack on sale with an edit waiting in the PendingReview view', async () => {
    await getCreatorShopReviewQueue({
      ...baseInput,
      status: 'PendingReview',
      cosmeticTypes: ['MysteryPack', 'Pack'],
    });
    expect(mysteryArm()).toEqual({
      itemDefinition: { sellerId: { not: null } },
      OR: [
        { status: 'PendingReview' },
        { status: 'Published', itemDefinition: { revisions: { some: { status: 'pending' } } } },
      ],
    });
    // Every other arm keeps the plain status filter.
    for (const arm of armsOf().filter((arm) => arm !== mysteryArm()))
      expect(arm).toMatchObject({ status: 'PendingReview' });
  });
});

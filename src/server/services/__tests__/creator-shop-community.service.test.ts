import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindMany: vi.fn(),
    shopItemCount: vi.fn(),
    getBlockedPairIds: vi.fn(),
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
vi.mock('~/server/services/user-preferences.service', () => ({
  getBlockedPairIds: mocks.getBlockedPairIds,
}));

import { CosmeticShopSort } from '~/server/common/enums';
import { getCommunityCosmetics } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.cosmeticShopItem.count.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemCount as (...a: unknown[]) => unknown)(...args)
);

const cosmeticBranch = (where: { OR: { cosmetic?: Record<string, never> }[] }) =>
  where.OR.find((b) => b.cosmetic)?.cosmetic as Record<string, never>;
const packBranch = (where: { OR: { cosmeticId?: null }[] }) =>
  where.OR.find((b) => 'cosmeticId' in b);

const itemRow = (id: number, meta: Record<string, unknown> = {}) => ({
  id,
  cosmeticId: id * 10,
  unitAmount: 500,
  title: `Item ${id}`,
  addedById: 11,
  meta: { purchases: 3, submissionTxId: 'tx-1', sellerShare: 20, imageHash: 'abc', ...meta },
  cosmetic: { id: id * 10, name: `Cosmetic ${id}`, type: 'Badge', createdById: 11 },
});

const baseInput = { limit: 40, page: 1, sort: CosmeticShopSort.Newest };

// Every `where` clause that isn't a plain top-level key lands in this array, so
// the assertions dig for theirs rather than pinning the whole list.
const andClauses = (where: { AND?: unknown[] }) => where.AND ?? [];

describe('getCommunityCosmetics', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindMany.mockResolvedValue([]);
    mocks.shopItemCount.mockResolvedValue(0);
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('strips payout/fee internals from item meta', async () => {
    mocks.shopItemFindMany.mockResolvedValue([itemRow(2), itemRow(1)]);
    mocks.shopItemCount.mockResolvedValue(2);
    const { items, totalPages } = await getCommunityCosmetics(baseInput);
    expect(items.map((i) => i.id)).toEqual([2, 1]);
    expect(items[0].meta).toEqual({ purchases: 3, acceptsBlueBuzz: false });
    expect(totalPages).toBe(1);
  });

  it('pages by skip/take and reports the page count from the total', async () => {
    mocks.shopItemFindMany.mockResolvedValue([itemRow(3), itemRow(2)]);
    mocks.shopItemCount.mockResolvedValue(7);
    const { items, totalItems, totalPages, currentPage } = await getCommunityCosmetics({
      ...baseInput,
      limit: 2,
      page: 3,
    });
    expect(mocks.shopItemFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, skip: 4 })
    );
    expect(items.map((i) => i.id)).toEqual([3, 2]);
    expect({ totalItems, totalPages, currentPage }).toEqual({
      totalItems: 7,
      totalPages: 4,
      currentPage: 3,
    });
  });

  it('counts with the same where clause it selects with', async () => {
    await getCommunityCosmetics({ ...baseInput, limited: true });
    expect(mocks.shopItemCount).toHaveBeenCalledWith({
      where: mocks.shopItemFindMany.mock.calls[0][0].where,
    });
  });

  it('only queries published creator items from public shops', async () => {
    // stickersEnabled so the flag's type exclusion doesn't muddy the assertion
    // that the caller's requested types pass through.
    await getCommunityCosmetics({
      ...baseInput,
      cosmeticTypes: ['Badge' as never],
      stickersEnabled: true,
    });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where.status).toBe('Published');
    // Packs have no cosmetic, so the creator gating sits in an OR branch now.
    expect(cosmeticBranch(where).createdById).toEqual({ not: null });
    expect(cosmeticBranch(where).type).toEqual({ in: ['Badge'] });
    // A type filter names cosmetic types, so it excludes packs.
    expect(packBranch(where)).toBeUndefined();
    expect(where.addedBy).toEqual({
      settings: { path: ['creatorShop', 'enabled'], equals: true },
    });
  });

  it('skips the block lookup for anonymous viewers', async () => {
    await getCommunityCosmetics(baseInput);
    expect(mocks.getBlockedPairIds).not.toHaveBeenCalled();
    expect(mocks.shopItemFindMany.mock.calls[0][0].where.addedById).toBeUndefined();
  });

  it('excludes creators with a block in either direction from the viewer', async () => {
    mocks.getBlockedPairIds.mockResolvedValue([5, 6]);
    await getCommunityCosmetics({ ...baseInput, viewerId: 99 });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    // Both the lister and the original creator — they differ on cross-listings.
    expect(where.addedById.notIn).toEqual(expect.arrayContaining([5, 6]));
    expect(cosmeticBranch(where).createdById).toEqual({ not: null, notIn: [5, 6] });
  });

  it('orders newest by approval time, not submission order', async () => {
    await getCommunityCosmetics(baseInput);
    expect(mocks.shopItemFindMany.mock.calls[0][0].orderBy).toEqual([
      { reviewedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'desc' },
    ]);
  });

  it.each([
    [CosmeticShopSort.Oldest, { reviewedAt: { sort: 'asc', nulls: 'first' } }],
    [CosmeticShopSort.PriceLowToHigh, { unitAmount: 'asc' }],
    [CosmeticShopSort.PriceHighToLow, { unitAmount: 'desc' }],
    [CosmeticShopSort.MostPopular, { purchases: { _count: 'desc' } }],
    [CosmeticShopSort.Name, { title: 'asc' }],
  ])('orders %s by its own key, tie-broken by id', async (sort, primary) => {
    await getCommunityCosmetics({ ...baseInput, sort });
    const orderBy = mocks.shopItemFindMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual(primary);
    expect(orderBy).toHaveLength(2);
    expect(Object.keys(orderBy[1])).toEqual(['id']);
  });

  it('limits to items with a capped quantity or an end date', async () => {
    await getCommunityCosmetics({ ...baseInput, limited: true });
    expect(andClauses(mocks.shopItemFindMany.mock.calls[0][0].where)).toContainEqual({
      OR: [{ availableQuantity: { not: null } }, { availableTo: { not: null } }],
    });
  });

  it('filters to wishlisted and blue-accepting items', async () => {
    await getCommunityCosmetics({
      ...baseInput,
      viewerId: 99,
      wishlisted: true,
      acceptsBlueBuzz: true,
    });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where.wishlists).toEqual({ some: { userId: 99 } });
    expect(where.meta).toEqual({ path: ['acceptsBlueBuzz'], equals: true });
  });

  it('hides owned items but keeps re-buyable content decorations and packs', async () => {
    await getCommunityCosmetics({ ...baseInput, viewerId: 99, owned: 'notOwned' });
    expect(andClauses(mocks.shopItemFindMany.mock.calls[0][0].where)).toContainEqual({
      OR: [
        { cosmeticId: null },
        { cosmetic: { type: 'ContentDecoration' } },
        { cosmetic: { UserCosmetic: { none: { userId: 99 } } } },
      ],
    });
  });

  it('keeps only owned items for the owned modifier', async () => {
    await getCommunityCosmetics({ ...baseInput, viewerId: 99, owned: 'owned' });
    expect(andClauses(mocks.shopItemFindMany.mock.calls[0][0].where)).toContainEqual({
      cosmetic: { UserCosmetic: { some: { userId: 99 } } },
    });
  });

  it('ignores viewer-scoped filters for anonymous callers', async () => {
    await getCommunityCosmetics({ ...baseInput, wishlisted: true, owned: 'notOwned' });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where.wishlists).toBeUndefined();
    expect(
      andClauses(where).some((clause) => JSON.stringify(clause).includes('UserCosmetic'))
    ).toBe(false);
  });
});

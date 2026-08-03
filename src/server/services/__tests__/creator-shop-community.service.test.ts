import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindMany: vi.fn(),
    getBlockedPairIds: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { cosmeticShopItem: { findMany: mocks.shopItemFindMany } },
  dbWrite: {},
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

import { getCommunityCosmetics } from '../creator-shop.service';

const itemRow = (id: number, meta: Record<string, unknown> = {}) => ({
  id,
  cosmeticId: id * 10,
  unitAmount: 500,
  title: `Item ${id}`,
  addedById: 11,
  meta: { purchases: 3, submissionTxId: 'tx-1', sellerShare: 20, imageHash: 'abc', ...meta },
  cosmetic: { id: id * 10, name: `Cosmetic ${id}`, type: 'Badge', createdById: 11 },
});

describe('getCommunityCosmetics', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindMany.mockResolvedValue([]);
    mocks.getBlockedPairIds.mockResolvedValue([]);
  });

  it('strips payout/fee internals from item meta', async () => {
    mocks.shopItemFindMany.mockResolvedValue([itemRow(2), itemRow(1)]);
    const { items, nextCursor } = await getCommunityCosmetics({ limit: 40 });
    expect(items.map((i) => i.id)).toEqual([2, 1]);
    expect(items[0].meta).toEqual({ purchases: 3, acceptsBlueBuzz: false });
    expect(nextCursor).toBeUndefined();
  });

  it('pages with limit+1: pops the extra row into nextCursor', async () => {
    mocks.shopItemFindMany.mockResolvedValue([itemRow(3), itemRow(2), itemRow(1)]);
    const { items, nextCursor } = await getCommunityCosmetics({ limit: 2 });
    expect(mocks.shopItemFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(items.map((i) => i.id)).toEqual([3, 2]);
    expect(nextCursor).toBe(1);
  });

  it('only queries published creator items from public shops', async () => {
    // stickersEnabled so the flag's type exclusion doesn't muddy the assertion
    // that the caller's requested types pass through.
    await getCommunityCosmetics({
      limit: 40,
      cosmeticTypes: ['Badge' as never],
      stickersEnabled: true,
    });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    expect(where.status).toBe('Published');
    expect(where.cosmetic.createdById).toEqual({ not: null });
    expect(where.cosmetic.type).toEqual({ in: ['Badge'] });
    expect(where.addedBy).toEqual({
      settings: { path: ['creatorShop', 'enabled'], equals: true },
    });
  });

  it('skips the block lookup for anonymous viewers', async () => {
    await getCommunityCosmetics({ limit: 40 });
    expect(mocks.getBlockedPairIds).not.toHaveBeenCalled();
    expect(mocks.shopItemFindMany.mock.calls[0][0].where.addedById).toBeUndefined();
  });

  it('excludes creators with a block in either direction from the viewer', async () => {
    mocks.getBlockedPairIds.mockResolvedValue([5, 6]);
    await getCommunityCosmetics({ limit: 40, viewerId: 99 });
    const { where } = mocks.shopItemFindMany.mock.calls[0][0];
    // Both the lister and the original creator — they differ on cross-listings.
    expect(where.addedById.notIn).toEqual(expect.arrayContaining([5, 6]));
    expect(where.cosmetic.createdById).toEqual({ not: null, notIn: [5, 6] });
  });
});

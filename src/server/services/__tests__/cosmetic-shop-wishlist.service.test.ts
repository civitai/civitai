import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    wishlistFindUnique: vi.fn(),
    wishlistFindMany: vi.fn(),
    wishlistCreateMany: vi.fn(),
    wishlistDeleteMany: vi.fn(),
    shopItemFindUnique: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    userCosmeticShopItemWishlist: { findMany: mocks.wishlistFindMany },
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique },
  },
  dbWrite: {
    userCosmeticShopItemWishlist: {
      findUnique: mocks.wishlistFindUnique,
      createMany: mocks.wishlistCreateMany,
      deleteMany: mocks.wishlistDeleteMany,
    },
  },
}));
vi.mock('sharp', () => ({ default: vi.fn() }));

import { getWishlistedShopItemIds, toggleWishlistShopItem } from '../cosmetic-shop.service';

describe('toggleWishlistShopItem', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.wishlistFindUnique.mockResolvedValue(null);
    mocks.wishlistCreateMany.mockResolvedValue({ count: 1 });
    mocks.wishlistDeleteMany.mockResolvedValue({ count: 1 });
    mocks.shopItemFindUnique.mockResolvedValue({ id: 42 });
  });

  it('adds with ON CONFLICT DO NOTHING so a racing double-click cannot duplicate', async () => {
    const result = await toggleWishlistShopItem({ userId: 1, shopItemId: 42, wishlisted: true });

    expect(result).toEqual({ shopItemId: 42, wishlisted: true });
    expect(mocks.wishlistCreateMany).toHaveBeenCalledWith({
      data: [{ userId: 1, shopItemId: 42 }],
      skipDuplicates: true,
    });
  });

  it('is a no-op when re-wishlisting something already wishlisted', async () => {
    mocks.wishlistFindUnique.mockResolvedValue({ shopItemId: 42 });

    const result = await toggleWishlistShopItem({ userId: 1, shopItemId: 42, wishlisted: true });

    expect(result).toEqual({ shopItemId: 42, wishlisted: true });
    expect(mocks.wishlistCreateMany).not.toHaveBeenCalled();
  });

  it('removes by userId + shopItemId, and removing twice does not error', async () => {
    mocks.wishlistDeleteMany.mockResolvedValue({ count: 0 });

    const result = await toggleWishlistShopItem({ userId: 1, shopItemId: 42, wishlisted: false });

    expect(result).toEqual({ shopItemId: 42, wishlisted: false });
    expect(mocks.wishlistDeleteMany).toHaveBeenCalledWith({ where: { userId: 1, shopItemId: 42 } });
    expect(mocks.wishlistCreateMany).not.toHaveBeenCalled();
  });

  it('flips the stored state when no desired state is given', async () => {
    mocks.wishlistFindUnique.mockResolvedValue({ shopItemId: 42 });

    const result = await toggleWishlistShopItem({ userId: 1, shopItemId: 42 });

    expect(result).toEqual({ shopItemId: 42, wishlisted: false });
    expect(mocks.wishlistDeleteMany).toHaveBeenCalled();
  });

  it('rejects a shop item that does not exist instead of hitting the FK', async () => {
    mocks.shopItemFindUnique.mockResolvedValue(null);

    await expect(
      toggleWishlistShopItem({ userId: 1, shopItemId: 999, wishlisted: true })
    ).rejects.toThrow();
    expect(mocks.wishlistCreateMany).not.toHaveBeenCalled();
  });
});

describe('getWishlistedShopItemIds', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
  });

  it('scopes to the viewer and returns ids in one query', async () => {
    mocks.wishlistFindMany.mockResolvedValue([{ shopItemId: 3 }, { shopItemId: 1 }]);

    const result = await getWishlistedShopItemIds({ userId: 7 });

    expect(result).toEqual([3, 1]);
    expect(mocks.wishlistFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.wishlistFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 7 } })
    );
  });
});

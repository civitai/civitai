import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    shopItemFindUnique: vi.fn(),
    shopItemDelete: vi.fn(),
    cosmeticDelete: vi.fn(),
    cosmeticDeleteMany: vi.fn(),
    userCosmeticDelete: vi.fn(),
    userCosmeticDeleteMany: vi.fn(),
    userFindUnique: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: { findUnique: mocks.shopItemFindUnique },
    user: { findUnique: mocks.userFindUnique },
  },
  dbWrite: {
    cosmeticShopItem: { delete: mocks.shopItemDelete },
    cosmetic: { delete: mocks.cosmeticDelete, deleteMany: mocks.cosmeticDeleteMany },
    userCosmetic: { delete: mocks.userCosmeticDelete, deleteMany: mocks.userCosmeticDeleteMany },
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

import { deleteCreatorShopItem } from '../creator-shop.service';

const shopItemRow = {
  id: 42,
  cosmeticId: 7,
  unitAmount: 500,
  status: 'Published',
  meta: {},
  addedById: 11,
  cosmetic: { createdById: 11, type: 'Badge', data: {} },
  _count: { purchases: 3 },
};

describe('deleteCreatorShopItem', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.shopItemFindUnique.mockResolvedValue(shopItemRow);
    mocks.shopItemDelete.mockResolvedValue(shopItemRow);
    // getCreatorShopSettings — no featured items, so no settings write happens.
    mocks.userFindUnique.mockResolvedValue({ settings: {} });
  });

  it('is moderator-only', async () => {
    await expect(deleteCreatorShopItem({ userId: 11, id: 42 })).rejects.toThrow(/Only moderators/);
    expect(mocks.shopItemDelete).not.toHaveBeenCalled();
  });

  it('deletes only the shop item row — never the Cosmetic or UserCosmetic records', async () => {
    const result = await deleteCreatorShopItem({ userId: 999, isModerator: true, id: 42 });

    expect(mocks.shopItemDelete).toHaveBeenCalledWith({ where: { id: 42 } });
    // Buyers keep their cosmetic: the Cosmetic row and UserCosmetic rows are
    // untouched (purchase records go via FK cascade on the shop item only).
    expect(mocks.cosmeticDelete).not.toHaveBeenCalled();
    expect(mocks.cosmeticDeleteMany).not.toHaveBeenCalled();
    expect(mocks.userCosmeticDelete).not.toHaveBeenCalled();
    expect(mocks.userCosmeticDeleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 42, purchases: 3 });
  });
});

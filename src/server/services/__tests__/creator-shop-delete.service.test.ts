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
import { dbMock } from '~/__tests__/mocks/db.mock';
dbMock.dbRead.cosmeticShopItem.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbRead.user.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.userFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmeticShopItem.delete.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemDelete as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmetic.delete.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticDelete as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.cosmetic.deleteMany.mockImplementation((...args: unknown[]) =>
  (mocks.cosmeticDeleteMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmetic.delete.mockImplementation((...args: unknown[]) =>
  (mocks.userCosmeticDelete as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.userCosmetic.deleteMany.mockImplementation((...args: unknown[]) =>
  (mocks.userCosmeticDeleteMany as (...a: unknown[]) => unknown)(...args)
);

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

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  refundTransaction: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  hasValidCreatorMembership: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

import { getCreatorShopManageItems } from '../creator-shop.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { soldCountsFake } from '~/test-utils/soldCountsFake';

const row = (id: number, availableQuantity: number | null) => ({
  id,
  availableQuantity,
  // The stored counter, deliberately unlike the rows below.
  meta: { purchases: 1 },
  _count: { resales: 2 },
});

// The creator's own inventory view: the sold count drives "remaining" and the
// sold-out state, so a wrong count here tells a creator stock they don't have.
describe('getCreatorShopManageItems', () => {
  beforeEach(() => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockReset();
    dbMock.dbRead.$queryRaw.mockReset();
  });

  it('derives purchases, remaining and sold-out from the purchase rows', async () => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([
      row(1, 10),
      row(2, 7),
      row(3, null),
    ]);
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({ 1: 7, 2: 7, 3: 4 }));

    const items = await getCreatorShopManageItems({ userId: 11 });

    expect(
      items.map(({ id, purchases, remaining, soldOut, resellerCount }) => ({
        id,
        purchases,
        remaining,
        soldOut,
        resellerCount,
      }))
    ).toEqual([
      { id: 1, purchases: 7, remaining: 3, soldOut: false, resellerCount: 2 },
      { id: 2, purchases: 7, remaining: 0, soldOut: true, resellerCount: 2 },
      { id: 3, purchases: 4, remaining: null, soldOut: false, resellerCount: 2 },
    ]);
  });

  it('never asks Prisma for the whole-table purchase aggregate', async () => {
    dbMock.dbRead.cosmeticShopItem.findMany.mockResolvedValue([]);
    await getCreatorShopManageItems({ userId: 11 });

    expect(
      dbMock.dbRead.cosmeticShopItem.findMany.mock.calls[0][0].select._count.select
    ).not.toHaveProperty('purchases');
  });
});

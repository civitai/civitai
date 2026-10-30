import { describe, expect, it } from 'vitest';
import { getPackPurchaseBlockers } from '~/components/CosmeticShop/pack-purchase-blockers';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

const buyable = {
  unavailableCount: 0,
  amountDue: 8800,
  listed: true,
  status: CosmeticShopItemStatus.Published,
  availableQuantity: 10 as number | null,
  isPackCreator: false,
  meta: { purchases: 3 },
};

describe('getPackPurchaseBlockers', () => {
  it('blocks nothing on a pack the server would sell', () => {
    expect(getPackPurchaseBlockers(buyable)).toEqual({
      unavailable: false,
      nothingLeftToBuy: false,
      offSale: false,
      soldOut: false,
      isOwnPack: false,
      blocked: false,
    });
  });

  // One server refusal per row, each alone, so dropping any one term from
  // `blocked` turns its row red.
  it.each([
    { flag: 'unavailable', over: { unavailableCount: 1 } },
    { flag: 'nothingLeftToBuy', over: { amountDue: 0 } },
    { flag: 'offSale', over: { listed: false } },
    { flag: 'offSale', over: { status: CosmeticShopItemStatus.Archived } },
    { flag: 'soldOut', over: { meta: { purchases: 10 } } },
    { flag: 'isOwnPack', over: { isPackCreator: true } },
  ] as const)('blocks on $flag alone', ({ flag, over }) => {
    const blockers = getPackPurchaseBlockers({ ...buyable, ...over });
    expect(blockers.blocked).toBe(true);
    expect(Object.entries(blockers).filter(([k, v]) => k !== 'blocked' && v)).toEqual([
      [flag, true],
    ]);
  });

  it('does not treat an uncapped pack as sold out', () => {
    expect(
      getPackPurchaseBlockers({ ...buyable, availableQuantity: null, meta: { purchases: 999 } })
        .blocked
    ).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { isPackShopItem } from '~/server/schema/creator-shop.schema';

// A mystery box listing has no cosmetic, which every pack guard used to read as "a pack". The pack
// editor would then write member rows onto it and send it back to review, and the public pack page
// would serve it as an empty pack.

const { getPackDetail, updateCreatorShopPack } = await import(
  '~/server/services/creator-shop-pack.service'
);

const MOD_ID = 70099;
const listing = (itemDefinitionId: number | null) => ({
  id: 6101,
  cosmeticId: null,
  itemDefinitionId,
  addedById: MOD_ID,
  title: 'Birthday box',
  description: null,
  unitAmount: 500,
  status: CosmeticShopItemStatus.Published,
  listed: false,
  availableQuantity: null,
  meta: {},
  members: [],
  _count: { purchases: 0 },
});

describe('isPackShopItem', () => {
  it('is false for a mystery box listing and true for a pack', () => {
    expect(isPackShopItem({ cosmeticId: null, itemDefinitionId: 9 })).toBe(false);
    expect(isPackShopItem({ cosmeticId: null, itemDefinitionId: null })).toBe(true);
    expect(isPackShopItem({ cosmeticId: 4, itemDefinitionId: null })).toBe(false);
  });
});

describe('pack guards on a mystery box listing', () => {
  beforeEach(() => {
    dbMock.dbRead.cosmeticShopItem.findUnique.mockReset();
  });

  it('getPackDetail refuses it', async () => {
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue(listing(9));
    await expect(getPackDetail({ shopItemId: 6101, isModerator: true })).rejects.toThrow(
      'This listing is not a pack'
    );
  });

  it('updateCreatorShopPack refuses it, for a moderator too', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValueOnce(listing(9));
    await expect(
      updateCreatorShopPack({ id: 6101, userId: MOD_ID, isModerator: true, name: 'x' })
    ).rejects.toThrow('This listing is not a pack');
  });

  it('getPackDetail still serves a real pack (control)', async () => {
    dbMock.dbRead.cosmeticShopItem.findUnique.mockResolvedValue(listing(null));
    await expect(getPackDetail({ shopItemId: 6101, isModerator: true })).resolves.toMatchObject({
      id: 6101,
    });
  });
});

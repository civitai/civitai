import { describe, expect, it } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { canPurchaseShopCosmetic } from '../shop-item-purchasable';

describe('canPurchaseShopCosmetic', () => {
  it('sells a sticker the viewer does not hold', () => {
    expect(
      canPurchaseShopCosmetic({
        type: CosmeticType.Sticker,
        owned: false,
        stickerRemaining: undefined,
      })
    ).toBe(true);
  });

  // A creator holds their own sticker from approval; once those uses are spent,
  // holding it must not hide the Purchase button.
  it.each([0, 12])('sells another batch of a sticker held with %i uses left', (remaining) => {
    expect(
      canPurchaseShopCosmetic({
        type: CosmeticType.Sticker,
        owned: true,
        stickerRemaining: remaining,
      })
    ).toBe(true);
  });

  it('does not sell more of a sticker held with unlimited uses', () => {
    expect(
      canPurchaseShopCosmetic({ type: CosmeticType.Sticker, owned: true, stickerRemaining: null })
    ).toBe(false);
  });

  it('does not sell a badge the viewer already holds', () => {
    expect(
      canPurchaseShopCosmetic({
        type: CosmeticType.Badge,
        owned: true,
        stickerRemaining: undefined,
      })
    ).toBe(false);
  });

  it('keeps selling content decorations to holders', () => {
    expect(
      canPurchaseShopCosmetic({
        type: CosmeticType.ContentDecoration,
        owned: true,
        stickerRemaining: undefined,
      })
    ).toBe(true);
  });
});

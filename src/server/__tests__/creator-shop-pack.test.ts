import { describe, expect, it } from 'vitest';
import {
  computePackOwnershipDiscount,
  isConsumableCosmeticType,
  packItemFloor,
  packPriceFloor,
  submitCreatorShopPackSchema,
  type PackMemberPricing,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';

// Deliberately unequal, and none equal to a floor: a fixture where two
// quantities coincide can't tell a correct result from several wrong ones.
const OWN_BADGE: PackMemberPricing = {
  cosmeticId: 11,
  type: CosmeticType.Badge,
  listPrice: 900,
  isOwn: true,
};
const OWN_DECORATION: PackMemberPricing = {
  cosmeticId: 12,
  type: CosmeticType.ProfileDecoration,
  listPrice: 2700,
  isOwn: true,
};
const OWN_STICKER: PackMemberPricing = {
  cosmeticId: 13,
  type: CosmeticType.Sticker,
  listPrice: 1800,
  isOwn: true,
};
const FOREIGN_BADGE: PackMemberPricing = {
  cosmeticId: 21,
  type: CosmeticType.Badge,
  listPrice: 1400,
  isOwn: false,
};

describe('packPriceFloor', () => {
  it('covers every foreign member at its own list price', () => {
    const members = [FOREIGN_BADGE, { ...FOREIGN_BADGE, cosmeticId: 22, listPrice: 3100 }];
    expect(packPriceFloor(members)).toBe(1400 + 3100);
  });

  it('ignores own members when summing foreign list prices', () => {
    // Own members contribute only their type floor, so a creator can discount
    // their own work inside a pack but never someone else's.
    const members = [OWN_DECORATION, FOREIGN_BADGE];
    const typeSum = packItemFloor(CosmeticType.ProfileDecoration) + packItemFloor(CosmeticType.Badge);
    expect(packPriceFloor(members)).toBe(Math.max(1400, typeSum));
  });

  it('falls back to the summed per-type floor for an all-own pack', () => {
    const members = [OWN_BADGE, OWN_DECORATION, OWN_STICKER];
    const typeSum =
      packItemFloor(CosmeticType.Badge) +
      packItemFloor(CosmeticType.ProfileDecoration) +
      packItemFloor(CosmeticType.Sticker);
    expect(packPriceFloor(members)).toBe(typeSum);
  });

  it('sums per-member type floors rather than multiplying one of them', () => {
    // Degenerate while the floors are equal; this asserts the shape that makes
    // a mixed-type pack price correctly once they diverge.
    const mixed = [OWN_BADGE, OWN_STICKER];
    expect(packPriceFloor(mixed)).toBe(
      packItemFloor(CosmeticType.Badge) + packItemFloor(CosmeticType.Sticker)
    );
  });
});

describe('computePackOwnershipDiscount', () => {
  const members = [OWN_BADGE, OWN_DECORATION, FOREIGN_BADGE];
  const packPrice = 6200;
  const ownPortion = packPrice - FOREIGN_BADGE.listPrice; // 4800
  const weightTotal = OWN_BADGE.listPrice + OWN_DECORATION.listPrice; // 3600

  it('gives no discount to a buyer who owns nothing', () => {
    const { discount } = computePackOwnershipDiscount({
      packPrice,
      members,
      ownedCosmeticIds: [],
    });
    expect(discount).toBe(0);
  });

  it('weights an owned member by its share of the pack creator own portion', () => {
    const { discount } = computePackOwnershipDiscount({
      packPrice,
      members,
      ownedCosmeticIds: [OWN_BADGE.cosmeticId],
    });
    expect(discount).toBe(Math.floor((900 / weightTotal) * ownPortion));
    // The share is of the pack creator's own portion, which is not bounded by
    // the member's individual list price — owning a cheap member can be worth
    // more than that member costs on its own. Their revenue, their call.
    expect(discount).toBeLessThan(ownPortion);
  });

  it('never discounts a foreign member the buyer already owns', () => {
    const { discount } = computePackOwnershipDiscount({
      packPrice,
      members,
      ownedCosmeticIds: [FOREIGN_BADGE.cosmeticId],
    });
    expect(discount).toBe(0);
  });

  it('floors each member individually rather than the total', () => {
    const { perMember, discount } = computePackOwnershipDiscount({
      packPrice,
      members,
      ownedCosmeticIds: [OWN_BADGE.cosmeticId, OWN_DECORATION.cosmeticId],
    });
    const expected = perMember.reduce((sum, m) => sum + m.discount, 0);
    expect(discount).toBe(expected);
    // Owning every own member surrenders the whole own portion — the buyer is
    // left paying exactly what the foreign members list for, never less.
    expect(discount).toBe(ownPortion);
    expect(packPrice - discount).toBe(FOREIGN_BADGE.listPrice);
  });

  it('gives a consumable member no discount but leaves its weight in the split', () => {
    const withSticker = [OWN_BADGE, OWN_STICKER, FOREIGN_BADGE];
    const { perMember, discount } = computePackOwnershipDiscount({
      packPrice,
      members: withSticker,
      ownedCosmeticIds: [OWN_BADGE.cosmeticId, OWN_STICKER.cosmeticId],
    });
    const stickerRow = perMember.find((m) => m.cosmeticId === OWN_STICKER.cosmeticId);
    expect(stickerRow?.discount).toBe(0);
    // The sticker's weight stays in the denominator, so owning the badge is
    // worth less here than it would be in a pack without the sticker.
    const denominator = OWN_BADGE.listPrice + OWN_STICKER.listPrice;
    expect(discount).toBe(Math.floor((OWN_BADGE.listPrice / denominator) * ownPortion));
  });

  it('never discounts more than the pack creator own portion', () => {
    const { discount } = computePackOwnershipDiscount({
      packPrice,
      members,
      ownedCosmeticIds: members.map((m) => m.cosmeticId),
    });
    expect(discount).toBeLessThanOrEqual(ownPortion);
  });
});

describe('isConsumableCosmeticType', () => {
  it('treats stickers as consumable and nothing else', () => {
    expect(isConsumableCosmeticType(CosmeticType.Sticker)).toBe(true);
    for (const type of [
      CosmeticType.Badge,
      CosmeticType.ProfileDecoration,
      CosmeticType.ProfileBackground,
      CosmeticType.ContentDecoration,
    ])
      expect(isConsumableCosmeticType(type)).toBe(false);
  });
});

describe('submitCreatorShopPackSchema', () => {
  const valid = {
    name: 'Starter pack',
    memberCosmeticIds: [11, 12, 13],
    price: 6200,
    imageUrl: 'abc-123',
    rightsAffirmed: true,
  };

  it('accepts a well-formed pack', () => {
    expect(submitCreatorShopPackSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a duplicated member', () => {
    const result = submitCreatorShopPackSchema.safeParse({
      ...valid,
      memberCosmeticIds: [11, 12, 11],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a pack with a single member', () => {
    const result = submitCreatorShopPackSchema.safeParse({ ...valid, memberCosmeticIds: [11] });
    expect(result.success).toBe(false);
  });

  it('defaults blue Buzz to off, since it is granted only if every member accepts', () => {
    const result = submitCreatorShopPackSchema.parse(valid);
    expect(result.acceptsBlueBuzz).toBe(false);
  });
});

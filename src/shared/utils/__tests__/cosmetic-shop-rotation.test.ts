import { describe, expect, it } from 'vitest';
import {
  rotateShopSectionItems,
  shopBlockMaxItems,
  visibleShopBlockItems,
} from '~/shared/utils/cosmetic-shop-rotation';

describe('shopBlockMaxItems', () => {
  it('shows 6 of a rotating block that names no maxItems, and all of one that does not rotate', () => {
    expect(shopBlockMaxItems({ random: true })).toBe(6);
    expect(shopBlockMaxItems({ random: true, maxItems: 4 })).toBe(4);
    expect(shopBlockMaxItems({})).toBeUndefined();
    expect(shopBlockMaxItems({ maxItems: 8 })).toBe(8);
  });
});

describe('rotateShopSectionItems', () => {
  it('gives two sections in the same window different orders', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const now = Date.UTC(2026, 9, 27, 12);

    expect(rotateShopSectionItems(items, { sectionId: 1, rotateHours: 3, now })).not.toEqual(
      rotateShopSectionItems(items, { sectionId: 2, rotateHours: 3, now })
    );
  });

  it('treats a hand-written rotateHours of 0 as one hour instead of dividing by zero', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const now = Date.UTC(2026, 9, 27, 12);

    expect(rotateShopSectionItems(items, { sectionId: 1, rotateHours: 0, now })).toEqual(
      rotateShopSectionItems(items, { sectionId: 1, rotateHours: 1, now })
    );
  });
});

const cosmetic = (id: number, creatorId: number | null) => ({
  shopItem: { id, addedById: 999, cosmetic: { creator: creatorId ? { id: creatorId } : null } },
});
const pack = (id: number, listerId: number) => ({
  shopItem: { id, addedById: listerId, cosmetic: null },
});
const shownIds = (items: { shopItem: { id: number } }[]) => items.map((i) => i.shopItem.id);

describe('visibleShopBlockItems', () => {
  const blocked = new Map([
    [50, true],
    [999, true],
  ]);

  it("drops a blocked creator's cosmetic and a blocked lister's pack, and fills the row from behind", () => {
    const items = [cosmetic(1, 50), cosmetic(2, 60), pack(3, 50), cosmetic(4, 61), cosmetic(5, 62)];

    expect(
      shownIds(visibleShopBlockItems(items, { blockRelations: blocked, maxItems: 3 }))
    ).toEqual([2, 4, 5]);
  });

  it('keeps an official cosmetic even when the mod who listed it is blocked', () => {
    // Official cosmetics have no creator; `addedById` is the listing mod, which the shop page
    // never block-filters a cosmetic on.
    expect(
      shownIds(visibleShopBlockItems([cosmetic(1, null)], { blockRelations: blocked }))
    ).toEqual([1]);
  });
});

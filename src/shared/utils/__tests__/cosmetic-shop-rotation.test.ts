import { describe, expect, it } from 'vitest';
import {
  rotateShopSectionItems,
  shopBlockMaxItems,
  visibleShopBlockItems,
} from '~/shared/utils/cosmetic-shop-rotation';

describe('shopBlockMaxItems', () => {
  it('shows 14 (two rows of the widest layout) of a rotating block that names no maxItems, and all of one that does not rotate', () => {
    expect(shopBlockMaxItems({ random: true })).toBe(14);
    expect(shopBlockMaxItems({ random: true, maxItems: 4 })).toBe(4);
    expect(shopBlockMaxItems({})).toBeUndefined();
    expect(shopBlockMaxItems({ maxItems: 8 })).toBe(8);
  });
});

describe('rotateShopSectionItems', () => {
  const HOUR = 60 * 60 * 1000;
  // The first window of a reshuffle for both 42 items (every 3 windows) and 43 (every 43).
  const start = 3 * 43 * 3 * HOUR * 1000;
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  const rotate = (
    items: number[],
    opts: { sectionId?: number; rotateHours?: number; now: number; visible?: number }
  ) =>
    rotateShopSectionItems(items, {
      sectionId: 59,
      rotateHours: 3,
      visible: 14,
      getId: (id) => id,
      ...opts,
    });
  /** The row each of `count` consecutive 3h windows shows. */
  const rows = (items: number[], count: number, visible = 14) =>
    Array.from({ length: count }, (_, w) =>
      rotate(items, { now: start + w * 3 * HOUR, visible }).slice(0, visible)
    );

  it('gives two sections in the same window different orders', () => {
    expect(rotate(ids(12), { sectionId: 1, now: start })).not.toEqual(
      rotate(ids(12), { sectionId: 2, now: start })
    );
  });

  it('treats a hand-written rotateHours of 0 as one hour instead of dividing by zero', () => {
    expect(rotate(ids(12), { rotateHours: 0, now: start })).toEqual(
      rotate(ids(12), { rotateHours: 1, now: start })
    );
  });

  it.each([42, 43, 30, 50, 97])(
    'never shows a card in two consecutive windows of a %i-item section, across reshuffles too',
    (n) => {
      const shown = rows(ids(n), 200);
      for (let w = 1; w < shown.length; w++) {
        expect(
          shown[w].filter((id) => shown[w - 1].includes(id)),
          `window ${w}`
        ).toEqual([]);
      }
    }
  );

  it('shows each of 42 items exactly once over three windows, every three windows', () => {
    const shown = rows(ids(42), 30);
    for (let w = 0; w < shown.length; w += 3) {
      expect(
        shown
          .slice(w, w + 3)
          .flat()
          .sort((a, b) => a - b)
      ).toEqual(ids(42));
    }
  });

  it('shows every item of a 43-item section within any four windows that do not straddle a reshuffle', () => {
    // 43 and 14 share no factor, so the walk comes back to its start after 43 windows.
    const shown = rows(ids(43), 43);
    for (let w = 0; w + 4 <= shown.length; w++) {
      expect(new Set(shown.slice(w, w + 4).flat()).size, `windows ${w}-${w + 3}`).toBe(43);
    }
  });

  it('keeps the whole section and its rows whatever order the database returned it in', () => {
    const items = ids(42);
    expect(rotate([...items].reverse(), { now: start })).toEqual(rotate(items, { now: start }));
  });

  it('shows the whole of a section no bigger than the row, and a full row of one under two rows', () => {
    expect(rows(ids(10), 2).map((row) => [...row].sort((a, b) => a - b))).toEqual([
      ids(10),
      ids(10),
    ]);
    for (const row of rows(ids(20), 20)) expect(new Set(row).size).toBe(14);
  });

  it('puts the next window behind the row, so a viewer who blocks a seller fills from it', () => {
    const now = start;
    expect(rotate(ids(42), { now }).slice(14, 28)).toEqual(rows(ids(42), 2)[1]);
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

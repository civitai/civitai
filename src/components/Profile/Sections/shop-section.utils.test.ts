import { describe, expect, it } from 'vitest';
import { getShopRowColumns, pickShopRowItems } from './shop-section.utils';

const items = (...ids: number[]) => ids.map((id) => ({ id }));
const ids = (list: { id: number }[]) => list.map((i) => i.id);

describe('pickShopRowItems', () => {
  const cosmetics = items(1, 2, 3, 4, 5, 6, 7, 8);

  it('shows the first N cosmetics when nothing is featured', () => {
    expect(ids(pickShopRowItems({ featured: [], cosmetics, columns: 5 }))).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts featured first in the creator order, then tops up without duplicates', () => {
    const featured = items(7, 3);
    expect(ids(pickShopRowItems({ featured, cosmetics, columns: 5 }))).toEqual([7, 3, 1, 2, 4]);
  });

  it('fills the row on a wide screen when 6 are featured and there are 8 in total', () => {
    const featured = items(2, 4, 6, 8, 1, 3);
    expect(ids(pickShopRowItems({ featured, cosmetics, columns: 8 }))).toEqual([
      2, 4, 6, 8, 1, 3, 5, 7,
    ]);
  });

  it('never exceeds one row, even when more are featured than fit', () => {
    const featured = items(1, 2, 3, 4, 5, 6);
    expect(pickShopRowItems({ featured, cosmetics, columns: 4 })).toHaveLength(4);
  });

  it('shows fewer than a full row when the creator has fewer cosmetics', () => {
    expect(ids(pickShopRowItems({ featured: [], cosmetics: items(1, 2), columns: 6 }))).toEqual([
      1, 2,
    ]);
  });

  it('returns nothing for an empty shop', () => {
    expect(pickShopRowItems({ featured: [], cosmetics: [], columns: 4 })).toEqual([]);
  });
});

describe('getShopRowColumns', () => {
  it('floors width / 280 and never drops below one', () => {
    expect(getShopRowColumns(0)).toBe(1);
    expect(getShopRowColumns(358)).toBe(1);
    expect(getShopRowColumns(1200)).toBe(4);
    expect(getShopRowColumns(4400)).toBe(15);
  });
});

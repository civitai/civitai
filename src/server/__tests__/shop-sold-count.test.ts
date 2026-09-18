import { describe, expect, it } from 'vitest';
import { withSoldCount } from '~/server/selectors/cosmetic-shop.selector';

/**
 * The read paths that hand `meta` to the client as-is — /shop's sections, the
 * moderator products table, the item editor — have no whitelist to change, so
 * the row count has to be written onto `meta.purchases` for them. The same
 * `<ShopItem>` renders both those and the creator storefront, which does have a
 * whitelist; without this it shows two different sold counts for one item
 * depending on which page you reached it from.
 *
 * TO WHOEVER IS ABOUT TO SIMPLIFY THIS AWAY: the overwrite is the point. A
 * spread that keeps the incoming `meta.purchases` passes every other assertion
 * in the suite and silently restores the drifting counter on three pages.
 */
describe('withSoldCount writes the row count onto the key clients read', () => {
  it('overwrites a counter that understates the rows', () => {
    // Prod item 74, "Fairy Pony (Limited Edition)": quantity 20, counter 0,
    // twenty purchase rows. The counter renders "20 remaining" on a sold-out
    // item behind a buy button that throws.
    const out = withSoldCount({ meta: { purchases: 0 }, _count: { purchases: 20 } });
    expect(out.meta.purchases).toBe(20);
  });

  it('overwrites a counter that overstates the rows', () => {
    const out = withSoldCount({ meta: { purchases: 737 }, _count: { purchases: 732 } });
    expect(out.meta.purchases).toBe(732);
  });

  it('reports zero sold rather than dropping the key when meta is null', () => {
    const out = withSoldCount({ meta: null, _count: { purchases: 0 } });
    expect(out.meta.purchases).toBe(0);
  });

  it('keeps the rest of meta, which is what the card and checkout render', () => {
    const out = withSoldCount({
      meta: { purchases: 0, acceptsBlueBuzz: true, coverUrl: 'cover.png' },
      _count: { purchases: 3 },
    });
    expect(out.meta).toEqual({ purchases: 3, acceptsBlueBuzz: true, coverUrl: 'cover.png' });
  });
});

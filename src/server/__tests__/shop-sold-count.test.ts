import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { cosmeticShopItemSelect } from '~/server/selectors/cosmetic-shop.selector';
import { getSoldCounts, withSoldCount } from '~/server/services/cosmetic-shop-sold-count';
import { soldCountsFake } from '~/test-utils/soldCountsFake';

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
    const out = withSoldCount({ meta: { purchases: 0 } }, 20);
    expect(out.meta.purchases).toBe(20);
  });

  it('overwrites a counter that overstates the rows', () => {
    const out = withSoldCount({ meta: { purchases: 737 } }, 732);
    expect(out.meta.purchases).toBe(732);
  });

  it('writes the count onto a null meta rather than dropping the key', () => {
    // Non-zero on purpose: with 0 here the case also passes under a reversed
    // spread order, which is the mutation that silently restores the counter.
    const out = withSoldCount({ meta: null }, 4);
    expect(out.meta.purchases).toBe(4);
  });

  it('keeps the rest of meta, which is what the card and checkout render', () => {
    const out = withSoldCount(
      { id: 74, meta: { purchases: 0, acceptsBlueBuzz: true, coverUrl: 'cover.png' } },
      3
    );
    expect(out.meta).toEqual({ purchases: 3, acceptsBlueBuzz: true, coverUrl: 'cover.png' });
    // An impl returning only `{ meta }` and dropping `...item` passes every
    // assertion above this one.
    expect(out.id).toBe(74);
  });
});

/**
 * TO WHOEVER IS ABOUT TO ADD `_count` BACK TO THE SHARED SELECTOR: Prisma
 * resolves a relation `_count` by aggregating the WHOLE purchases table once per
 * query, so its cost tracks the table rather than the page. Every read of this
 * selector gets its sold count from `getSoldCounts`, restricted to the ids it
 * returned.
 */
describe('the shared selector carries no whole-table purchase aggregate', () => {
  it('has no `_count`', () => {
    expect('_count' in cosmeticShopItemSelect).toBe(false);
  });
});

describe('getSoldCounts', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockImplementation(soldCountsFake({ 1: 3, 2: 9 }));
  });

  it('asks for exactly the ids it was given, once each', async () => {
    const sold = await getSoldCounts([2, 1, 2, 5]);

    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.$queryRaw.mock.calls[0].slice(1)).toEqual([[2, 1, 5]]);
    expect([...sold]).toEqual([
      [2, 9],
      [1, 3],
    ]);
  });

  /**
   * The service tests all answer through `soldCountsFake`, which cannot tell a count
   * of purchases from a count of buyers, the right column from the wrong one, or an
   * int4 from Postgres' int8 `COUNT(*)` — which Prisma returns as a BigInt and which
   * then throws in `availableQuantity - purchases`. This is the one place that sees
   * the statement itself.
   */
  it('emits exactly the per-item purchase count, cast to int', async () => {
    await getSoldCounts([1]);

    const strings = dbMock.dbRead.$queryRaw.mock.calls[0][0] as string[];
    expect(strings.join('$1').replace(/\s+/g, ' ').trim()).toBe(
      'SELECT "shopItemId", COUNT(*)::int AS sold FROM "UserCosmeticShopPurchases" ' +
        'WHERE "shopItemId" = ANY($1::int[]) GROUP BY "shopItemId"'
    );
  });

  it('skips the query for an empty page', async () => {
    expect((await getSoldCounts([])).size).toBe(0);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEAL_PERCENT,
  dealPrice,
  ROTATION_SIZE,
  msUntilNextDay,
  stockFor,
  utcDay,
  type ShopItem,
} from '../knights-shop';

const item = (id: number, over: Partial<ShopItem> = {}): ShopItem => ({
  id,
  kind: 'cosmetic',
  name: `item ${id}`,
  description: '',
  price: 1000,
  buzz: null,
  cosmeticId: 1,
  tier: null,
  months: null,
  minRank: null,
  active: true,
  rotating: true,
  sortOrder: 0,
  ...over,
});

const PACK = 100;
const MEMBER = 101;
const OFF = 102;
const cosmeticIds = Array.from({ length: 12 }, (_, i) => i + 1);

const CATALOG = [
  ...cosmeticIds.map((id) => item(id)),
  item(PACK, { kind: 'buzz_pack', rotating: false, buzz: 50, cosmeticId: null }),
  item(MEMBER, {
    kind: 'membership',
    rotating: false,
    tier: 'silver',
    months: 1,
    cosmeticId: null,
  }),
  item(OFF, { active: false, rotating: false }),
];

describe('the daily rotation', () => {
  it('gives the same stock and deals for the same UTC day, whatever the order or the hour', () => {
    const a = stockFor(CATALOG, '2026-12-20');
    const b = stockFor([...CATALOG].reverse(), '2026-12-20');

    expect(b).toEqual(a);
    expect(stockFor(CATALOG, utcDay(new Date('2026-12-20T00:00:00Z')))).toEqual(a);
    expect(stockFor(CATALOG, utcDay(new Date('2026-12-20T23:59:59Z')))).toEqual(a);
  });

  it('changes at UTC midnight', () => {
    const days = ['2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23'].map((d) =>
      stockFor(CATALOG, d)
        .stock.map((s) => s.item.id)
        .join()
    );
    expect(new Set(days).size).toBeGreaterThan(1);
    expect(utcDay(new Date('2026-12-20T23:59:59.999Z'))).toBe('2026-12-20');
    expect(utcDay(new Date('2026-12-21T00:00:00Z'))).toBe('2026-12-21');
  });

  it('always sells fixed items and never an inactive one, and rotates a fixed number of the rest', () => {
    const { stock } = stockFor(CATALOG, '2026-12-20');
    const ids = stock.map((s) => s.item.id);

    expect(ids).toEqual(expect.arrayContaining([PACK, MEMBER]));
    expect(ids).not.toContain(OFF);
    expect(ids.filter((id) => cosmeticIds.includes(id))).toHaveLength(ROTATION_SIZE);
  });

  it("picks deals from today's stock and takes the deal percent off", () => {
    const { stock, deals } = stockFor(CATALOG, '2026-12-20');

    expect(deals.length).toBeGreaterThan(0);
    for (const deal of deals) {
      expect(stock.map((s) => s.item.id)).toContain(deal.item.id);
      expect(deal.price).toBe(Math.floor((deal.item.price * (100 - DEAL_PERCENT)) / 100));
    }
    expect(stock.filter((s) => s.deal).map((s) => s.item.id)).toEqual(deals.map((d) => d.item.id));
  });

  it('breaks sortOrder ties by numeric id, so 10 sorts after 9', () => {
    const { stock } = stockFor([item(10), item(9), item(100)], '2026-12-20');

    expect(stock.map((s) => s.item.id)).toEqual([9, 10, 100]);
  });

  it('never prices a deal at zero gold', () => {
    expect(dealPrice(1)).toBe(1);
    expect(dealPrice(1000)).toBe(800);
  });

  it('copes with a catalog smaller than the rotation', () => {
    expect(stockFor([item(7)], '2026-12-20').stock.map((s) => s.item.id)).toEqual([7]);
    expect(stockFor([], '2026-12-20')).toEqual({ stock: [], deals: [] });
  });

  it('counts down to the next UTC midnight', () => {
    expect(msUntilNextDay(new Date('2026-12-20T22:00:00Z'))).toBe(2 * 3_600_000);
  });
});

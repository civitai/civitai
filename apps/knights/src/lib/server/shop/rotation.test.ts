import { describe, expect, it } from 'vitest';
import {
  DEAL_PERCENT,
  ROTATION_SIZE,
  msUntilNextDay,
  stockFor,
  utcDay,
  type ShopItem,
} from './rotation';

const item = (id: string, over: Partial<ShopItem> = {}): ShopItem => ({
  id,
  kind: 'cosmetic',
  name: id,
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

const CATALOG = [
  ...Array.from({ length: 12 }, (_, i) => item(`c${i}`)),
  item('pack', { kind: 'buzz_pack', rotating: false, buzz: 50, cosmeticId: null }),
  item('member', {
    kind: 'membership',
    rotating: false,
    tier: 'silver',
    months: 1,
    cosmeticId: null,
  }),
  item('off', { active: false, rotating: false }),
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

    expect(ids).toEqual(expect.arrayContaining(['pack', 'member']));
    expect(ids).not.toContain('off');
    expect(ids.filter((id) => id.startsWith('c'))).toHaveLength(ROTATION_SIZE);
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

  it('copes with a catalog smaller than the rotation', () => {
    expect(stockFor([item('only')], '2026-12-20').stock.map((s) => s.item.id)).toEqual(['only']);
    expect(stockFor([], '2026-12-20')).toEqual({ stock: [], deals: [] });
  });

  it('counts down to the next UTC midnight', () => {
    expect(msUntilNextDay(new Date('2026-12-20T22:00:00Z'))).toBe(2 * 3_600_000);
  });
});

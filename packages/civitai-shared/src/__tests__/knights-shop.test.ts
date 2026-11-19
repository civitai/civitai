import { describe, expect, it } from 'vitest';
import {
  DEAL_PERCENT,
  dealPrice,
  ROTATION_SIZE,
  msUntilNextDay,
  stockFor,
  utcDay,
  withheldCosmeticIds,
  type CosmeticListing,
  type CosmeticOwnerRow,
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
  days: null,
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
    days: 7,
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

  it('offers no deals by default', () => {
    const { stock, deals } = stockFor(CATALOG, '2026-12-20');
    expect(deals).toEqual([]);
    expect(stock.every((s) => !s.deal && s.price === s.item.price)).toBe(true);
  });

  it("picks deals from today's stock and takes the deal percent off", () => {
    const { stock, deals } = stockFor(CATALOG, '2026-12-20', { dealsPerDay: 2 });

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

describe('withheldCosmeticIds', () => {
  const creator = (id: number, flags = 0) => ({ id, createdById: 9, flags });
  const listing = (over: Partial<CosmeticListing> = {}): CosmeticListing => ({
    cosmeticId: 1,
    addedById: 9,
    status: 'PendingReview',
    meta: {},
    rejectionReason: null,
    ...over,
  });
  const withheld = (
    cosmetics: CosmeticOwnerRow[] = [creator(1)],
    listings: CosmeticListing[] = []
  ) => [...withheldCosmeticIds(cosmetics, listings)];

  it('withholds a creator cosmetic whose listing is waiting for review', () => {
    expect(withheld([creator(1)], [listing()])).toEqual([1]);
  });

  it('lets a published listing, or one a moderator approved, through', () => {
    expect(withheld([creator(1)], [listing({ status: 'Published' })])).toEqual([]);
    const approved = { history: [{ kind: 'reviewed', action: 'approve' }] };
    expect(withheld([creator(1)], [listing({ status: 'Archived', meta: approved })])).toEqual([]);
  });

  it('withholds an approved listing again once something people see was edited', () => {
    const meta = {
      history: [
        { kind: 'reviewed', action: 'approve' },
        { kind: 'edited', changes: [{ field: 'artwork' }] },
      ],
    };
    expect(withheld([creator(1)], [listing({ meta })])).toEqual([1]);
  });

  it('withholds a rejected or unpublished taken-down listing, but not a published one', () => {
    const rejected = { history: [{ kind: 'reviewed', action: 'reject' }] };
    expect(withheld([creator(1)], [listing({ meta: rejected })])).toEqual([1]);
    expect(
      withheld([creator(1)], [listing({ status: 'Published', meta: { takedown: {} } })])
    ).toEqual([]);
    expect(
      withheld([creator(1)], [listing({ meta: { takedown: {}, displayApproved: true } })])
    ).toEqual([1]);
  });

  it("ignores system cosmetics and other creators' cross-listings", () => {
    expect(withheld([{ id: 1, createdById: null, flags: 0 }], [listing()])).toEqual([]);
    expect(withheld([creator(1)], [listing({ addedById: 7 })])).toEqual([]);
  });

  it('keeps a cosmetic withheld after its pending listing was deleted (Withheld flag)', () => {
    expect(withheld([creator(1, 4)], [])).toEqual([1]);
    expect(withheld([creator(1, 0)], [])).toEqual([]);
    expect(withheld([creator(1, 4)], [listing({ status: 'Published' })])).toEqual([]);
  });
});

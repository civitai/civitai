import { describe, expect, it } from 'vitest';
import {
  availability,
  countdown,
  cosmeticMedia,
  filterItems,
  groupByKind,
  nameplateGradient,
  restoreNote,
  secondaryLine,
  previewDays,
  statusCounts,
  todayOf,
  type Query,
} from '../shop-view';
import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';

const row = (id: number, o: Partial<ShopItemRow> = {}): ShopItemRow =>
  ({
    id,
    kind: 'buzz_pack',
    name: `Item ${id}`,
    description: '',
    price: 1000,
    buzz: 50,
    cosmeticId: null,
    tier: null,
    days: null,
    minRank: null,
    active: true,
    rotating: false,
    sortOrder: 0,
    cosmeticName: null,
    cosmeticType: null,
    cosmeticData: null,
    ...o,
  } as ShopItemRow);

const live: Query = { q: '', status: 'live', kind: '' };

describe('availability', () => {
  const today = todayOf([
    { id: 2, price: 800, deal: true, hidden: false },
    { id: 3, price: 500, deal: false, hidden: false },
  ]);

  it('puts retired before every other state', () => {
    expect(availability(row(1, { active: false, kind: 'membership', days: 30 }), today).kind).toBe(
      'retired'
    );
  });

  it('flags a membership that is not one week as not sold, with the reason', () => {
    const result = availability(row(1, { kind: 'membership', tier: 'gold', days: 30 }), today);
    expect(result).toMatchObject({ kind: 'not-sold', label: 'Not sold' });
    expect(result.tip).toMatch(/one week/);
  });

  it('flags a cosmetic whose row is gone', () => {
    expect(availability(row(1, { kind: 'cosmetic', cosmeticId: 9 }), today)).toMatchObject({
      kind: 'hidden',
      label: 'Hidden: cosmetic missing',
    });
  });

  it('flags a cosmetic still in review, with the reason', () => {
    const result = availability(
      row(1, { kind: 'cosmetic', cosmeticId: 9, cosmeticType: 'Badge', cosmeticWithheld: true }),
      today
    );
    expect(result).toMatchObject({ kind: 'hidden', label: 'Hidden: cosmetic in review' });
    expect(result.tip).toMatch(/in review/);
  });

  it('tells a fixed item, a rotating pick and a rotating miss apart', () => {
    expect(availability(row(1), today).label).toBe('Always on sale');
    expect(availability(row(3, { rotating: true }), today).label).toBe('Rotating · in today');
    expect(availability(row(4, { rotating: true }), today).label).toBe('Rotating · not today');
  });

  it("carries today's deal price only for an item that is a deal", () => {
    expect(availability(row(2, { rotating: true }), today).deal).toBe(800);
    expect(availability(row(3, { rotating: true }), today).deal).toBeNull();
  });
});

describe('filterItems', () => {
  const items = [
    row(1, { name: 'Buzz 50' }),
    row(2, { name: 'Gold week', kind: 'membership', tier: 'gold', days: 7 }),
    row(3, { name: 'Pride', kind: 'cosmetic', cosmeticName: 'Gay Pride', active: false }),
  ];

  it('shows only live items by default and only retired ones on request', () => {
    expect(filterItems(items, live).map((i) => i.id)).toEqual([1, 2]);
    expect(filterItems(items, { ...live, status: 'retired' }).map((i) => i.id)).toEqual([3]);
    expect(filterItems(items, { ...live, status: 'all' })).toHaveLength(3);
  });

  it("matches by name, #id and the cosmetic's own name", () => {
    const all = { ...live, status: 'all' } as const;
    expect(filterItems(items, { ...all, q: 'gold' }).map((i) => i.id)).toEqual([2]);
    expect(filterItems(items, { ...all, q: '#3' }).map((i) => i.id)).toEqual([3]);
    expect(filterItems(items, { ...all, q: 'gay' }).map((i) => i.id)).toEqual([3]);
  });

  it('narrows by kind and counts every status regardless of the filter', () => {
    expect(filterItems(items, { ...live, kind: 'membership' }).map((i) => i.id)).toEqual([2]);
    expect(statusCounts(items)).toEqual({ live: 2, retired: 1, all: 3 });
  });

  it('groups in the order the Knights shop lays them out and drops empty groups', () => {
    expect(groupByKind([...items].reverse()).map((g) => g.kind)).toEqual([
      'buzz_pack',
      'membership',
      'cosmetic',
    ]);
    expect(groupByKind([items[1]]).map((g) => g.kind)).toEqual(['membership']);
  });
});

describe('cosmeticMedia', () => {
  it('returns the image for a previewable type and null for a nameplate or a missing url', () => {
    expect(cosmeticMedia({ cosmeticType: 'Badge', cosmeticData: { url: 'a.png' } })).toEqual({
      url: 'a.png',
      type: undefined,
    });
    expect(cosmeticMedia({ cosmeticType: 'NamePlate', cosmeticData: { url: 'a.png' } })).toBeNull();
    expect(cosmeticMedia({ cosmeticType: 'Badge', cosmeticData: {} })).toBeNull();
  });
});

describe('countdown', () => {
  it('shows hours and minutes, then minutes and seconds in the last hour', () => {
    expect(countdown((3 * 3600 + 12 * 60 + 59) * 1000)).toBe('3h 12m');
    expect(countdown((12 * 60 + 5) * 1000)).toBe('12m 05s');
    expect(countdown(-5)).toBe('0m 00s');
  });
});

describe('previewDays', () => {
  it('lists today, tomorrow and five more days, in UTC', () => {
    const days = previewDays('2026-12-30', '2026-12-30');
    expect(days).toHaveLength(7);
    expect(days.slice(0, 3)).toEqual([
      { value: '2026-12-30', label: 'Today' },
      { value: '2026-12-31', label: 'Tomorrow' },
      { value: '2027-01-01', label: 'Fri 1 Jan' },
    ]);
  });

  it('appends a typed-in day beyond the chips so the selection stays visible', () => {
    const days = previewDays('2026-12-30', '2027-03-01');
    expect(days).toHaveLength(8);
    expect(days[7].value).toBe('2027-03-01');
  });
});

describe('sticker and nameplate rendering', () => {
  it('shows a sticker as an image and carries whether it moves', () => {
    expect(
      cosmeticMedia({
        cosmeticType: 'Sticker',
        cosmeticData: { url: 'abc', slug: 'x', uses: 100, animated: false },
      })
    ).toEqual({ url: 'abc', type: undefined, animated: false });
  });

  it('turns a gradient nameplate into CSS and refuses other variants and non-hex colours', () => {
    const gradient = { from: '#ff90b6', to: '#ffa1c1', deg: 180 };
    expect(
      nameplateGradient({
        cosmeticType: 'NamePlate',
        cosmeticData: { variant: 'gradient', gradient },
      })
    ).toBe('linear-gradient(180deg, #ff90b6, #ffa1c1)');
    expect(
      nameplateGradient({ cosmeticType: 'NamePlate', cosmeticData: { variant: 'solid' } })
    ).toBeNull();
    expect(
      nameplateGradient({
        cosmeticType: 'NamePlate',
        cosmeticData: { variant: 'gradient', gradient: { from: 'red);x', to: '#fff' } },
      })
    ).toBeNull();
    expect(
      nameplateGradient({ cosmeticType: 'Badge', cosmeticData: { variant: 'gradient', gradient } })
    ).toBeNull();
  });
});

describe('secondaryLine', () => {
  const pack = (name: string) => row(1, { name, price: 1000, buzz: 50 });

  it("does not repeat a Buzz pack's name and gives its gold rate instead", () => {
    expect(secondaryLine(pack('50 Buzz'))).toBe('20 gold / Buzz');
    expect(secondaryLine(pack('Starter'))).toBe('50 Buzz · 20 gold / Buzz');
  });

  it('rounds the rate to one decimal', () => {
    expect(secondaryLine(row(1, { name: 'a', price: 962, buzz: 50 }))).toBe(
      '50 Buzz · 19.2 gold / Buzz'
    );
    expect(secondaryLine(row(1, { name: '11 Buzz', price: 200, buzz: 11 }))).toBe(
      '18.2 gold / Buzz'
    );
  });

  it("keeps a membership's tier and length and a cosmetic's type", () => {
    expect(secondaryLine(row(2, { kind: 'membership', tier: 'bronze', days: 7 }))).toBe(
      'Bronze · 1 week'
    );
    expect(secondaryLine(row(3, { kind: 'cosmetic', cosmeticType: 'Sticker' }))).toBe('Sticker');
  });
});

describe('restoreNote', () => {
  it('says why a restored item still would not sell, and is silent when it will', () => {
    expect(restoreNote(row(1, { kind: 'membership', days: 30 }))).toMatch(/stays off sale/);
    expect(restoreNote(row(2, { kind: 'cosmetic', cosmeticId: 9 }))).toMatch(/stays hidden/);
    expect(restoreNote(row(3))).toBeNull();
    expect(restoreNote(row(4, { kind: 'cosmetic', cosmeticType: 'Badge' }))).toBeNull();
  });
});

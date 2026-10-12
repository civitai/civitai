import { describe, expect, it } from 'vitest';
import {
  daysOnTeam,
  orderRoster,
  hatTier,
  isNewMember,
  podiumHero,
  rosterPricePoints,
  rosterRanks,
  ROSTER_NEW_MS,
  slotPlan,
} from '~/components/Events/ScoredEvent/roster/roster-cards.utils';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 10) + ms);
// Join times in whole minutes: the rank key counts join time by the minute.
const member = (hatCount: number, points: number, joinedMin = 0) => ({
  hatCount,
  points,
  joinedAt: at(joinedMin * 60_000),
});

describe('rosterRanks', () => {
  it('numbers members in order when no one ties', () => {
    expect(rosterRanks([member(5, 0), member(4, 0), member(1, 0)], 'hats')).toEqual([1, 2, 3]);
  });

  it('gives tied members the better rank and skips the places they share', () => {
    const items = [member(5, 0), member(4, 0), member(4, 0), member(2, 0)];
    expect(rosterRanks(items, 'hats')).toEqual([1, 2, 2, 4]);
  });

  it('does not share a rank when the rest of the key breaks the tie', () => {
    // The reported Team Blue pair: 1 hat each, 4,006 and 953 points. Distinct on every sort.
    const items = [member(1, 4006), member(1, 953)];
    expect(rosterRanks(items, 'hats')).toEqual([1, 2]);
    expect(rosterRanks(items, 'points')).toEqual([1, 2]);
    // Same hats and points: the join time breaks it.
    expect(rosterRanks([member(1, 5, 2000), member(1, 5, 1000)], 'hats')).toEqual([1, 2]);
  });

  it('shares a rank only when every standing in the key ties', () => {
    expect(rosterRanks([member(2, 5, 1000), member(2, 5, 1000)], 'hats')).toEqual([1, 1]);
    expect(rosterRanks([member(2, 5, 1000), member(2, 5, 1000)], 'points')).toEqual([1, 1]);
    // Newest is join time then points: hats are not in it.
    expect(rosterRanks([member(9, 5, 1000), member(1, 5, 1000)], 'newest')).toEqual([1, 1]);
  });

  it('ties newest only in the same join minute', () => {
    const items = [member(0, 0, 2000), member(0, 0, 2000), member(0, 0, 1000)];
    expect(rosterRanks(items, 'newest')).toEqual([1, 1, 3]);
    // Seconds apart in one minute: a tie.
    const second = { ...member(0, 0, 2000), joinedAt: at(2000 * 60_000 + 30_000) };
    expect(rosterRanks([second, member(0, 0, 2000)], 'newest')).toEqual([1, 1]);
  });

  it('carries a tie across what were two pages', () => {
    // The page flattens its pages before ranking; the 25th member ties the 24th.
    const items = [...Array.from({ length: 23 }, (_, i) => member(100 - i, 0)), member(7, 0)];
    items.push(member(7, 0));
    const ranks = rosterRanks(items, 'hats');
    expect(ranks.slice(-2)).toEqual([24, 24]);
  });
});

describe('isNewMember', () => {
  it('is new until 24 hours after joining, and not at 24 hours', () => {
    const joined = at(0);
    expect(isNewMember(joined, at(ROSTER_NEW_MS - 1))).toBe(true);
    expect(isNewMember(joined, at(ROSTER_NEW_MS))).toBe(false);
  });
});

describe('daysOnTeam', () => {
  it('counts whole days', () => {
    expect(daysOnTeam(at(0), at(ROSTER_NEW_MS - 1))).toBe(0);
    expect(daysOnTeam(at(0), at(3 * ROSTER_NEW_MS + 5))).toBe(3);
  });
});

describe('hatTier', () => {
  const prices = rosterPricePoints([
    [{ price: 3000 }, { price: null }],
    [{ price: 500 }, { price: 1500 }, { price: 500 }],
  ]);

  it('lists each price once, cheapest first, without the free hat', () => {
    expect(prices).toEqual([500, 1500, 3000]);
  });

  it('puts the free join hat at tier 0 and the dearest at tier 3', () => {
    expect(hatTier(null, prices)).toBe(0);
    expect(hatTier(500, prices)).toBe(1);
    expect(hatTier(1500, prices)).toBe(2);
    expect(hatTier(3000, prices)).toBe(3);
  });
});

describe('slotPlan', () => {
  it('shows every hat when they fit, with no +N', () => {
    expect(slotPlan(8, 8)).toEqual({ shown: 8, more: 0 });
    expect(slotPlan(0, 8)).toEqual({ shown: 0, more: 0 });
  });

  it('gives up one slot to a +N for the rest when they do not', () => {
    expect(slotPlan(9, 8)).toEqual({ shown: 7, more: 2 });
    expect(slotPlan(23, 10)).toEqual({ shown: 9, more: 14 });
  });
});

describe('podiumHero', () => {
  const hat = (cosmeticId: number, worn: boolean, url: string | null = `u${cosmeticId}`) => ({
    cosmeticId,
    name: `h${cosmeticId}`,
    url,
    worn,
  });

  it('heroes the worn hat and leaves the rest for the mini row', () => {
    const result = podiumHero([hat(1, true), hat(2, false), hat(3, false)]);
    expect(result.hero?.cosmeticId).toBe(1);
    expect(result.label).toBe('wearing');
    expect(result.rest.map((h) => h.cosmeticId)).toEqual([2, 3]);
  });

  it('heroes the first (dearest) hat as the top hat when none is worn', () => {
    const result = podiumHero([hat(2, false), hat(3, false)]);
    expect(result.hero?.cosmeticId).toBe(2);
    expect(result.label).toBe('top');
    expect(result.rest.map((h) => h.cosmeticId)).toEqual([3]);
  });

  it('has no hero for a member with no hats, nor one whose hats have no art', () => {
    expect(podiumHero([]).label).toBe('none');
    expect(podiumHero([hat(4, true, null)]).hero).toBeUndefined();
  });
});

describe('orderRoster', () => {
  const m = (id: number, points: number, hatCount = 0) => ({
    user: { id },
    ...member(hatCount, points),
  });

  it('re-sorts by the active sort when cached totals moved', () => {
    const ids = orderRoster([m(1, 10), m(2, 8), m(3, 50)], 'points').map((x) => x.user.id);
    expect(ids).toEqual([3, 1, 2]);
  });

  const order = (items: ReturnType<typeof m>[], sort: 'hats' | 'points' | 'newest') =>
    orderRoster(items, sort).map((x) => x.user.id);
  const at2 = (id: number, hatCount: number, points: number, joinedMin: number) => ({
    user: { id },
    ...member(hatCount, points, joinedMin),
  });

  // The member id last, by its string highest first, as a reversed Redis range orders equal scores.
  it('breaks a hats tie by points, then the newest join, then the member string', () => {
    expect(order([at2(1, 1, 953, 0), at2(2, 1, 4006, 0)], 'hats')).toEqual([2, 1]);
    expect(order([at2(1, 1, 5, 1000), at2(2, 1, 5, 2000)], 'hats')).toEqual([2, 1]);
    expect(order([at2(2, 1, 5, 0), at2(9, 1, 5, 0), at2(5, 1, 5, 0)], 'hats')).toEqual([9, 5, 2]);
    expect(order([at2(10, 1, 5, 0), at2(9, 1, 5, 0), at2(100, 1, 5, 0)], 'hats')).toEqual([
      9, 100, 10,
    ]);
  });

  it('breaks a points tie by hats, then the newest join, then the member string', () => {
    expect(order([at2(1, 1, 50, 0), at2(2, 3, 50, 0)], 'points')).toEqual([2, 1]);
    expect(order([at2(1, 2, 50, 1000), at2(2, 2, 50, 2000)], 'points')).toEqual([2, 1]);
    expect(order([at2(2, 2, 50, 0), at2(9, 2, 50, 0)], 'points')).toEqual([9, 2]);
  });

  // Later fields disagree with each other: only the key's own priority decides.
  it('puts points before join time for hats, and hats before join time for points', () => {
    expect(order([at2(1, 1, 50, 2000), at2(2, 1, 100, 1000)], 'hats')).toEqual([2, 1]);
    expect(order([at2(1, 1, 50, 2000), at2(2, 3, 50, 1000)], 'points')).toEqual([2, 1]);
    // Newest: points before the member string.
    expect(order([at2(1, 0, 1, 1000), at2(2, 0, 2, 1000)], 'newest')).toEqual([2, 1]);
  });

  it('breaks a newest tie by points, then the member string, ignoring hats', () => {
    expect(order([at2(1, 9, 1, 1000), at2(2, 0, 2, 1000)], 'newest')).toEqual([2, 1]);
    expect(order([at2(2, 9, 1, 1000), at2(9, 0, 1, 1000)], 'newest')).toEqual([9, 2]);
  });

  it('orders the same members the same way whatever order they arrive in', () => {
    const items = [at2(9, 1, 5, 0), at2(2, 1, 5, 0), at2(5, 1, 5, 0)];
    expect(order([...items].reverse(), 'hats')).toEqual(order(items, 'hats'));
  });

  it('keeps one card per member when a later page repeats one', () => {
    const ids = orderRoster([m(1, 10), m(2, 8), m(2, 8), m(3, 5)], 'points').map((x) => x.user.id);
    expect(ids).toEqual([1, 2, 3]);
  });
});

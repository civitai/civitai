import { describe, expect, it } from 'vitest';
import {
  daysOnTeam,
  hatTier,
  isNewMember,
  podiumHero,
  rosterPricePoints,
  rosterRanks,
  ROSTER_NEW_MS,
  slotPlan,
} from '~/components/Events/ScoredEvent/roster/roster-cards.utils';

const at = (ms: number) => new Date(Date.UTC(2026, 9, 10) + ms);
const member = (hatCount: number, points: number, joinedMs = 0) => ({
  hatCount,
  points,
  joinedAt: at(joinedMs),
});

describe('rosterRanks', () => {
  it('numbers members in order when no one ties', () => {
    expect(rosterRanks([member(5, 0), member(4, 0), member(1, 0)], 'hats')).toEqual([1, 2, 3]);
  });

  it('gives tied members the better rank and skips the places they share', () => {
    const items = [member(5, 0), member(4, 0), member(4, 0), member(2, 0)];
    expect(rosterRanks(items, 'hats')).toEqual([1, 2, 2, 4]);
  });

  it('ranks by the active sort only', () => {
    // Same hats, different points: tied on hats, not on points.
    const items = [member(3, 90), member(3, 40)];
    expect(rosterRanks(items, 'hats')).toEqual([1, 1]);
    expect(rosterRanks(items, 'points')).toEqual([1, 2]);
  });

  it('ties newest only on the same join instant', () => {
    const items = [member(0, 0, 2000), member(0, 0, 2000), member(0, 0, 1000)];
    expect(rosterRanks(items, 'newest')).toEqual([1, 1, 3]);
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

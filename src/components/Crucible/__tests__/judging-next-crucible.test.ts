import { describe, expect, it } from 'vitest';
import {
  judgingWeight,
  pickNextCrucible,
  pickWeightedCrucible,
} from '~/components/Crucible/judging-next-crucible';

// Server order: createdAt desc, id desc.
const list = [
  { id: 30, createdAt: new Date('2026-10-05') },
  { id: 20, createdAt: new Date('2026-10-03') },
  { id: 10, createdAt: new Date('2026-10-01') },
];

describe('pickNextCrucible', () => {
  it('steps to the crucible after the current one', () => {
    expect(pickNextCrucible(list, list[0])?.id).toBe(20);
    expect(pickNextCrucible(list, list[1])?.id).toBe(10);
  });

  it('wraps from the last crucible to the first', () => {
    expect(pickNextCrucible(list, list[2])?.id).toBe(30);
  });

  it('walks the whole list when repeated', () => {
    const seen: number[] = [];
    let from = list[0];
    for (let i = 0; i < list.length; i++) {
      const next = pickNextCrucible(list, from);
      if (!next) throw new Error('expected a next crucible');
      seen.push(next.id);
      from = next;
    }
    expect(seen).toEqual([20, 10, 30]);
  });

  it('goes to the first older crucible when the current one is not listed', () => {
    expect(pickNextCrucible(list, { id: 25, createdAt: new Date('2026-10-04') })?.id).toBe(20);
  });

  it('orders a createdAt tie by id, as the server does', () => {
    expect(pickNextCrucible(list, { id: 25, createdAt: new Date('2026-10-03') })?.id).toBe(20);
    expect(pickNextCrucible(list, { id: 15, createdAt: new Date('2026-10-03') })?.id).toBe(10);
  });

  it('goes to the first crucible when none listed is older than the current one', () => {
    expect(pickNextCrucible(list, { id: 5, createdAt: new Date('2026-09-01') })?.id).toBe(30);
  });

  it('reads a createdAt that arrives as a string', () => {
    expect(
      pickNextCrucible(list, { id: 25, createdAt: '2026-10-04T00:00:00.000Z' as unknown as Date })
        ?.id
    ).toBe(20);
  });

  it('returns null when the only crucible listed is the current one', () => {
    expect(pickNextCrucible([list[1]], list[1])).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(pickNextCrucible([], list[0])).toBeNull();
  });
});

describe('pickWeightedCrucible', () => {
  const now = new Date('2026-10-09T00:00:00Z').getTime();
  const inDays = (days: number) => new Date(now + days * 24 * 60 * 60 * 1000);
  // Newest first, as the server sends them.
  const newer = { id: 2, endAt: inDays(6), remainingPairs: 40 };
  const closingSoon = { id: 1, endAt: inDays(0.5), remainingPairs: 40 };

  it('favours a crucible closing soon over a newer one with the same pairs left', () => {
    expect(judgingWeight(closingSoon, now)).toBeGreaterThan(4 * judgingWeight(newer, now));
    const picks = [0.1, 0.5, 0.8].map(
      (roll) => pickWeightedCrucible([newer, closingSoon], { now, random: () => roll })?.id
    );
    expect(picks).toEqual([2, 1, 1]);
  });

  it('favours more pairs left when crucibles close together', () => {
    const few = { id: 3, endAt: inDays(2), remainingPairs: 1 };
    const many = { id: 4, endAt: inDays(2), remainingPairs: 100 };
    expect(judgingWeight(many, now)).toBeCloseTo(10 * judgingWeight(few, now));
  });

  it('weighs an open-ended crucible as far from closing', () => {
    const openEnded = { id: 5, endAt: null, remainingPairs: 40 };
    expect(judgingWeight(openEnded, now)).toBeLessThan(judgingWeight(newer, now));
    expect(judgingWeight(openEnded, now)).toBeGreaterThan(0);
  });

  it('never picks a crucible with no pairs left', () => {
    const caughtUp = { id: 6, endAt: inDays(0.1), remainingPairs: 0 };
    for (const roll of [0, 0.5, 0.999]) {
      expect(pickWeightedCrucible([caughtUp, newer], { now, random: () => roll })?.id).toBe(2);
    }
  });

  it('reads an endAt that arrives as a string', () => {
    const asString = { ...closingSoon, endAt: inDays(0.5).toISOString() as unknown as Date };
    expect(judgingWeight(asString, now)).toBe(judgingWeight(closingSoon, now));
  });

  it('returns null for an empty list', () => {
    expect(pickWeightedCrucible([], { now })).toBeNull();
  });
});

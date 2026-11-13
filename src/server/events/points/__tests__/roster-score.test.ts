import { describe, expect, it } from 'vitest';
import {
  JOIN_BITS,
  joinDate,
  joinMinute,
  MAX_HATS,
  MAX_POINTS,
  packStanding,
  POINT_STEP,
  unpackPointsScore,
} from '~/server/events/points/roster-score';
import { rosterComparator } from '~/shared/utils/roster-order';

const START = new Date('2026-11-01T00:00:00.000Z');
const MAX_JOIN = 2 ** JOIN_BITS - 1;
const SORTS = ['hats', 'points', 'newest'] as const;

describe('roster rank score packing', () => {
  it('stays an exact integer at the top of every field', () => {
    for (const sort of SORTS) {
      const top = packStanding(sort, { hats: MAX_HATS, points: MAX_POINTS, joinMinute: MAX_JOIN });
      expect(Number.isSafeInteger(top)).toBe(true);
    }
  });

  it('round-trips a points-sort score, including every field at its edge', () => {
    for (const standing of [
      { hats: 0, points: 0, joinMinute: 0 },
      { hats: 1, points: 4006, joinMinute: 131_000 },
      { hats: MAX_HATS, points: MAX_POINTS, joinMinute: MAX_JOIN },
    ])
      expect(unpackPointsScore(packStanding('points', standing))).toEqual({
        standing,
        overflow: false,
      });
  });

  it('clamps each field into its bits instead of carrying into the next', () => {
    expect(
      unpackPointsScore(
        packStanding('points', { hats: MAX_HATS + 9, points: MAX_POINTS + 9, joinMinute: -5 })
      ).standing
    ).toEqual({ hats: MAX_HATS, points: MAX_POINTS, joinMinute: 0 });
  });

  it("adds one point per POINT_STEP to each sort's score", () => {
    const at = { hats: 3, points: 1000, joinMinute: 500 };
    for (const sort of SORTS)
      expect(packStanding(sort, { ...at, points: 1001 }) - packStanding(sort, at)).toBe(
        POINT_STEP[sort]
      );
  });

  it('flags a points-sort score that an award carried past the field', () => {
    const top = packStanding('points', { hats: 1, points: MAX_POINTS, joinMinute: 7 });
    expect(unpackPointsScore(top + POINT_STEP.points).overflow).toBe(true);
  });

  // The packed order is the comparator's order: the server's pages and the client's re-sort agree.
  it('orders packed scores as the shared comparator orders standings', () => {
    const minute = (m: number) => joinDate(m, START);
    const rows = [
      [1, 50, 10],
      [1, 50, 11],
      [1, 49, 99],
      [2, 0, 0],
      [1, 50, 10],
      [0, 999, 5],
    ].map(([hatCount, points, m], i) => ({ id: i + 1, hatCount, points, joinedAt: minute(m) }));
    for (const sort of SORTS) {
      const score = (r: (typeof rows)[number]) =>
        packStanding(sort, {
          hats: r.hatCount,
          points: r.points,
          joinMinute: joinMinute(r.joinedAt, START),
        });
      const byScore = [...rows]
        .sort((a, b) => score(b) - score(a) || (String(a.id) > String(b.id) ? -1 : 1))
        .map((r) => r.id);
      expect(byScore).toEqual([...rows].sort(rosterComparator(sort, (r) => r.id)).map((r) => r.id));
    }
  });
});

describe('join minutes', () => {
  it('counts whole minutes from 91 days before the start, and back', () => {
    const at = new Date(START.getTime() + 90_000);
    const m = joinMinute(at, START);
    expect(joinDate(m, START).getTime()).toBe(START.getTime() + 60_000);
    expect(joinMinute(START, START)).toBe(2 ** (JOIN_BITS - 1));
  });

  it('clamps a join outside the 182-day window to its ends', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(joinMinute(new Date(START.getTime() - 200 * day), START)).toBe(0);
    expect(joinMinute(new Date(START.getTime() + 200 * day), START)).toBe(MAX_JOIN);
  });
});

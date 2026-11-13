import { describe, expect, it } from 'vitest';
import {
  catchUpMultiplier,
  nextStickerAt,
  refillStock,
  scaleSupply,
  stepAt,
  stickerExpiresAt,
} from '~/server/events/turf/schedule';

// Illustrative numbers, not any event's real schedule.
const at = (iso: string) => new Date(iso);
const SUPPLY = [
  { from: at('2030-01-10T00:00:00Z'), perHour: 10, cap: 100 },
  { from: at('2030-01-01T00:00:00Z'), perHour: 5, cap: 50 },
];

describe('refillStock', () => {
  it('integrates each step for the time it was in force across a boundary', () => {
    // 2h at 5/h before the boundary, 2h at 10/h after: 30. The current rate alone gives 40.
    expect(
      refillStock(0, at('2030-01-09T22:00:00Z'), at('2030-01-10T02:00:00Z'), SUPPLY)
    ).toBeCloseTo(30);
  });

  it('stops at the cap in force at the time, then grows under the next cap', () => {
    // 48 fills to 50 before the boundary (not 58), then 2h at 10/h: 70.
    expect(
      refillStock(48, at('2030-01-09T22:00:00Z'), at('2030-01-10T02:00:00Z'), SUPPLY)
    ).toBeCloseTo(70);
  });

  it('accrues nothing before the first step', () => {
    expect(
      refillStock(0, at('2029-12-31T20:00:00Z'), at('2030-01-01T01:00:00Z'), SUPPLY)
    ).toBeCloseTo(5);
  });
});

describe('stepAt', () => {
  it('picks the step in force, whatever the list order', () => {
    expect(stepAt(SUPPLY, at('2030-01-05T00:00:00Z'))?.perHour).toBe(5);
    expect(stepAt(SUPPLY, at('2030-01-12T00:00:00Z'))?.perHour).toBe(10);
    expect(stepAt(SUPPLY, at('2029-10-01T00:00:00Z'))).toBeUndefined();
  });
});

describe('nextStickerAt', () => {
  const now = at('2030-01-01T12:00:00Z');
  const step = { from: at('2030-01-01T00:00:00Z'), perHour: 5, cap: 50 };

  it('is when the fraction in hand reaches the next whole sticker', () => {
    // 7.4 needs 0.6 more at 5/h: 7m 12s.
    expect(nextStickerAt(7.4, now, step)).toEqual(at('2030-01-01T12:07:12Z'));
    expect(nextStickerAt(7, now, step)).toEqual(at('2030-01-01T12:12:00Z'));
  });

  it('is null at or over the cap, with no rate, or before the first step', () => {
    expect(nextStickerAt(50, now, step)).toBeNull();
    expect(nextStickerAt(53, now, step)).toBeNull();
    expect(nextStickerAt(3, now, { ...step, perHour: 0 })).toBeNull();
    expect(nextStickerAt(3, now, undefined)).toBeNull();
  });
});

describe('catchUpMultiplier', () => {
  const step = { from: at('2030-01-01T00:00:00Z'), max: 2, min: 0.5, gap: 0.2 };
  const MEAN = 1000;

  it.each([
    ['at the mean', 1000, 1],
    ['half the gap below', 900, 1.5],
    ['exactly the gap below', 800, 2],
    ['far past the gap below', 100, 2],
    ['half the gap above', 1100, 0.75],
    ['exactly the gap above', 1200, 0.5],
    ['far past the gap above', 5000, 0.5],
  ])('%s', (_, points, m) => {
    expect(catchUpMultiplier(step, points, MEAN)).toBeCloseTo(m);
  });

  it('is 1 with no step in force, or before any team has points', () => {
    expect(catchUpMultiplier(undefined, 100, MEAN)).toBe(1);
    expect(catchUpMultiplier(step, 0, 0)).toBe(1);
  });
});

describe('refillStock with a catch-up multiplier', () => {
  const ONE = [{ from: at('2030-01-01T00:00:00Z'), perHour: 10, cap: 100 }];

  it('scales the rate and cap of every step, across a step boundary', () => {
    // 2h at 5/h x 1.5, then 2h at 10/h x 1.5: 45. Cap 75 under the first step does not bind.
    expect(
      refillStock(
        0,
        at('2030-01-09T22:00:00Z'),
        at('2030-01-10T02:00:00Z'),
        scaleSupply(SUPPLY, 1.5)
      )
    ).toBeCloseTo(45);
  });

  it('a multiplier that changes between refills applies to each period it was current for', () => {
    // 3h at 10/h x 1.5 = 45, written back at the refill; then 2h at 10/h x 0.75 = 15 more.
    const mid = refillStock(
      0,
      at('2030-01-02T00:00:00Z'),
      at('2030-01-02T03:00:00Z'),
      scaleSupply(ONE, 1.5)
    );
    const end = refillStock(
      mid,
      at('2030-01-02T03:00:00Z'),
      at('2030-01-02T05:00:00Z'),
      scaleSupply(ONE, 0.75)
    );
    expect(mid).toBeCloseTo(45);
    expect(end).toBeCloseTo(60);
  });

  it('a lowered cap keeps stock already above it, and adds nothing until spent below it', () => {
    // Filled to 140 under 1.4x (cap 140); at 0.75x the cap is 75: kept at 140, not cut, not grown.
    expect(
      refillStock(
        140,
        at('2030-01-02T00:00:00Z'),
        at('2030-01-02T05:00:00Z'),
        scaleSupply(ONE, 0.75)
      )
    ).toBeCloseTo(140);
    expect(scaleSupply(ONE, 0.75)[0]).toMatchObject({ perHour: 7.5, cap: 75 });
  });

  it('a multiplier of 1 leaves the schedule as it is', () => {
    expect(scaleSupply(SUPPLY, 1)).toBe(SUPPLY);
  });

  it('caps stay whole stickers, rounded down', () => {
    // 50 x 0.58 is 28.999... in floating point.
    expect(scaleSupply([{ ...ONE[0], cap: 50 }], 0.58)[0].cap).toBe(29);
    expect(scaleSupply([{ ...ONE[0], cap: 50 }], 0.875)[0].cap).toBe(43);
  });
});

// What the viewer's own hat counts down to; the server's queries use stickerLiveAfter, the same rule.
describe('stickerExpiresAt', () => {
  const placed = at('2030-01-05T00:00:00Z');

  it('is the lifetime after placing', () => {
    expect(stickerExpiresAt(placed, { ttlHours: 48 })).toEqual(at('2030-01-07T00:00:00Z'));
  });

  it('runs from the rollout for a sticker placed before it', () => {
    const rolloutAt = at('2030-01-10T00:00:00Z');
    expect(stickerExpiresAt(placed, { ttlHours: 48, rolloutAt })).toEqual(
      at('2030-01-12T00:00:00Z')
    );
  });

  it('is null with no lifetime', () => {
    expect(stickerExpiresAt(placed, {})).toBeNull();
  });
});

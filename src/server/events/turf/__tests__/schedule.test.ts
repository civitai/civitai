import { describe, expect, it } from 'vitest';
import { refillStock, stepAt } from '~/server/events/turf/schedule';

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

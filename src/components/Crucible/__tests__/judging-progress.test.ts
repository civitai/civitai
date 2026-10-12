import { describe, expect, it } from 'vitest';
import { getPairProgress } from '~/components/Crucible/judging-progress';

describe('getPairProgress', () => {
  it('counts down one pair per vote while the total holds', () => {
    const a = getPairProgress({ judgedPairs: 3, totalPairs: 20, remainingPairs: 12 });
    const b = getPairProgress({ judgedPairs: 4, totalPairs: 20, remainingPairs: 7 });
    expect(a).toMatchObject({ total: 20, toGo: 17, finished: false });
    expect(b).toMatchObject({ total: 20, toGo: 16, finished: false });
  });

  it('is finished with a full bar once nothing is left to vote on, however many pairs the total holds', () => {
    expect(getPairProgress({ judgedPairs: 14, totalPairs: 20, remainingPairs: 0 })).toEqual({
      total: 14,
      toGo: 0,
      percent: 100,
      finished: true,
    });
  });

  it('never reports more judged than the total', () => {
    const p = getPairProgress({ judgedPairs: 9, totalPairs: 5, remainingPairs: 2 });
    expect(p.total).toBe(9);
    expect(p.toGo).toBe(0);
    expect(p.percent).toBe(100);
  });

  it('is not finished with no pairs at all', () => {
    expect(getPairProgress({ judgedPairs: 0, totalPairs: 0, remainingPairs: 0 })).toMatchObject({
      finished: false,
      percent: 0,
    });
  });
});

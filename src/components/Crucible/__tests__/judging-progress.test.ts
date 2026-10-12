import { describe, expect, it } from 'vitest';
import { getPairProgress } from '~/components/Crucible/judging-progress';

describe('getPairProgress', () => {
  it('counts down one pair per vote while the total holds', () => {
    expect(getPairProgress({ judgedPairs: 5, totalPairs: 20, votesUsedUp: false })).toEqual({
      total: 20,
      toGo: 15,
      percent: 25,
      finished: false,
    });
    expect(getPairProgress({ judgedPairs: 6, totalPairs: 20, votesUsedUp: false })).toEqual({
      total: 20,
      toGo: 14,
      percent: 30,
      finished: false,
    });
  });

  it('is finished with a full bar once the server says votes are used up', () => {
    expect(getPairProgress({ judgedPairs: 14, totalPairs: 20, votesUsedUp: true })).toEqual({
      total: 14,
      toGo: 0,
      percent: 100,
      finished: true,
    });
  });

  it('is not finished when entries are merely hidden by the browsing level', () => {
    expect(getPairProgress({ judgedPairs: 4, totalPairs: 0, votesUsedUp: false })).toEqual({
      total: 4,
      toGo: 0,
      percent: 100,
      finished: false,
    });
  });

  it('never reports more judged than the total', () => {
    const p = getPairProgress({ judgedPairs: 9, totalPairs: 5, votesUsedUp: false });
    expect(p).toMatchObject({ total: 9, toGo: 0, percent: 100 });
  });

  it('is not finished with no pairs at all', () => {
    expect(getPairProgress({ judgedPairs: 0, totalPairs: 0, votesUsedUp: true })).toMatchObject({
      finished: false,
      percent: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { bestPerUserInRankOrder } from '~/server/games/daily-challenge/challenge-judging-engine';

const entry = (imageId: number, userId: number) => ({ imageId, userId });

describe('bestPerUserInRankOrder', () => {
  it('keeps whichever entry the ranking put first, not the one that sorts first by id', () => {
    // alice (100) is ranked 9th and 1st; bob (200) 2nd and 10th. Picking by imageId gives [1, 2].
    const ranked = [entry(9, 100), entry(2, 200), entry(1, 100), entry(10, 200)];

    expect(bestPerUserInRankOrder(ranked).map((e) => e.imageId)).toEqual([9, 2]);
  });

  it('preserves the ranking order of the survivors', () => {
    const ranked = [entry(5, 300), entry(6, 100), entry(7, 200), entry(8, 100)];

    expect(bestPerUserInRankOrder(ranked).map((e) => e.userId)).toEqual([300, 100, 200]);
  });

  it('is the identity when every user already has exactly one entry', () => {
    const ranked = [entry(1, 100), entry(2, 200), entry(3, 300)];

    expect(bestPerUserInRankOrder(ranked)).toEqual(ranked);
  });

  it('collapses a user who took every place', () => {
    const ranked = [entry(1, 100), entry(2, 100), entry(3, 100)];

    expect(bestPerUserInRankOrder(ranked).map((e) => e.imageId)).toEqual([1]);
  });

  it('handles an empty field', () => {
    expect(bestPerUserInRankOrder([])).toEqual([]);
  });
});

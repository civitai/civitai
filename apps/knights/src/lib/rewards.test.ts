import { describe, expect, it } from 'vitest';
import { rewardDeltas } from './rewards';

const standing = (over: Partial<Parameters<typeof rewardDeltas>[0]> = {}) => ({
  level: 12,
  xpIntoLevel: 100,
  xpForNextLevel: 500,
  goldEarned: 40,
  goldPending: 5,
  ...over,
});

describe('rewardDeltas', () => {
  it('has nothing to show on the first read', () => {
    expect(rewardDeltas(null, standing())).toEqual({ xp: 0, gold: 0, goldEarned: 0 });
  });

  it('reports XP and pending gold gained by a vote', () => {
    expect(rewardDeltas(standing(), standing({ xpIntoLevel: 112, goldPending: 8 }))).toEqual({
      xp: 12,
      gold: 3,
      goldEarned: 0,
    });
  });

  it('counts XP across a level boundary', () => {
    expect(
      rewardDeltas(
        standing({ xpIntoLevel: 495 }),
        standing({ level: 13, xpIntoLevel: 7, xpForNextLevel: 520 })
      )
    ).toMatchObject({ xp: 12 });
  });

  it('reports gold that settles into earned', () => {
    expect(rewardDeltas(standing(), standing({ goldEarned: 43, goldPending: 2 }))).toEqual({
      xp: 0,
      gold: 3,
      goldEarned: 3,
    });
  });

  it('shows nothing when the numbers fall (conversion, reset)', () => {
    expect(
      rewardDeltas(
        standing(),
        standing({ level: 1, xpIntoLevel: 0, goldEarned: 0, goldPending: 0 })
      )
    ).toEqual({
      xp: 0,
      gold: 0,
      goldEarned: 0,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { getLevelProgression } from '../new-order-levels';

describe('getLevelProgression', () => {
  it.each([
    [0, 1],
    [249, 1],
    [250, 2],
    [544, 2],
    [545, 3],
    [20_000, 17],
  ])('puts %i total xp at level %i', (xp, level) => {
    expect(getLevelProgression(xp).level).toBe(level);
  });

  it('reports the progress inside the level the player is on', () => {
    expect(getLevelProgression(300)).toEqual({
      level: 2,
      totalXp: 50,
      xpForCurrentLevel: 250,
      xpForNextLevel: 295,
      xpIntoLevel: 50,
      xpToNextLevel: 245,
      progressPercent: 16.95,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { expForLevel, getLevelProgression, MAX_LEVEL } from './levels';

describe('getLevelProgression', () => {
  it('starts at level 1 with 250 XP to the next', () => {
    expect(getLevelProgression(0)).toMatchObject({
      level: 1,
      xpIntoLevel: 0,
      xpForNextLevel: 250,
      xpToNextLevel: 250,
    });
  });

  it('keeps the original game curve up to level 20', () => {
    expect(expForLevel(2)).toBe(250);
    expect(expForLevel(20)).toBe(30_594);
    expect(getLevelProgression(30_593).level).toBe(19);
    expect(getLevelProgression(30_594).level).toBe(20);
  });

  it('grows 6% a level from level 20 on, not 18%', () => {
    expect(getLevelProgression(30_594).xpForNextLevel).toBe(5_163);
    expect(expForLevel(21)).toBe(35_757);
    expect(expForLevel(50)).toBe(438_370);
    expect(expForLevel(90)).toBe(5_020_501);
  });

  it('puts a player on the level their XP reaches, with the XP into it', () => {
    expect(getLevelProgression(35_756).level).toBe(20);
    expect(getLevelProgression(35_757 + 100)).toMatchObject({
      level: 21,
      xpIntoLevel: 100,
      xpForNextLevel: 5_472,
      xpToNextLevel: 5_372,
    });
    expect(getLevelProgression(438_370).level).toBe(50);
    expect(getLevelProgression(5_020_500).level).toBe(89);
    expect(getLevelProgression(5_020_501).level).toBe(90);
  });

  it('maps existing XP to its new level', () => {
    const levels = [30_594, 1_000_000, 5_000_000, 20_000_000, 97_000_000].map(
      (xp) => getLevelProgression(xp).level
    );
    expect(levels).toEqual([20, 63, 89, 113, 140]);
  });

  it('never goes down as XP grows', () => {
    let last = 0;
    for (let xp = 0; xp < 6_000_000; xp += 997) {
      const { level } = getLevelProgression(xp);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });
});

describe('expForLevel', () => {
  it('is the first XP of the level on the curve', () => {
    expect(expForLevel(1)).toBe(0);
    for (const level of [2, 20, 21, 50, 90, MAX_LEVEL]) {
      expect(getLevelProgression(expForLevel(level))).toMatchObject({ level, xpIntoLevel: 0 });
    }
  });

  it('allows levels well past the Paladin band', () => {
    expect(MAX_LEVEL).toBeGreaterThan(120);
  });

  it('refuses levels that do not exist or would not fit an Int', () => {
    expect(() => expForLevel(0)).toThrow(RangeError);
    expect(() => expForLevel(MAX_LEVEL + 1)).toThrow(RangeError);
    expect(expForLevel(MAX_LEVEL)).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

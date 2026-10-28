import { describe, expect, it } from 'vitest';
import { getLevelProgression } from '@civitai/shared/new-order-levels';
import { expForLevel, MAX_LEVEL } from './levels';

describe('expForLevel', () => {
  it('is the first XP of the level on the shared curve', () => {
    expect(expForLevel(1)).toBe(0);
    for (const level of [2, 21, 41, MAX_LEVEL]) {
      expect(getLevelProgression(expForLevel(level))).toMatchObject({ level, xpIntoLevel: 0 });
    }
  });

  it('refuses levels that do not exist or would not fit an Int', () => {
    expect(() => expForLevel(0)).toThrow(RangeError);
    expect(() => expForLevel(MAX_LEVEL + 1)).toThrow(RangeError);
    expect(expForLevel(MAX_LEVEL)).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

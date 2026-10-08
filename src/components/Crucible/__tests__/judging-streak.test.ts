import { describe, expect, it } from 'vitest';
import {
  getStreakTier,
  isStreakBlazing,
  isStreakMilestone,
} from '~/components/Crucible/judging-streak';

describe('getStreakTier', () => {
  it.each([
    [0, 'none'],
    [1, 'warm'],
    [4, 'warm'],
    [5, 'hot'],
    [9, 'hot'],
    [10, 'fire'],
    [24, 'fire'],
    [25, 'fire'],
    [30, 'fire'],
  ] as const)('streak %i is %s', (streak, tier) => {
    expect(getStreakTier(streak)).toBe(tier);
  });

  it('treats a negative streak as none', () => {
    expect(getStreakTier(-1)).toBe('none');
  });
});

describe('isStreakBlazing', () => {
  it.each([
    [0, false],
    [10, false],
    [24, false],
    [25, true],
    [30, true],
  ])('streak %i blazing: %s', (streak, expected) => {
    expect(isStreakBlazing(streak)).toBe(expected);
  });
});

describe('isStreakMilestone', () => {
  it.each([
    [0, false],
    [1, false],
    [4, false],
    [5, false],
    [9, false],
    [10, true],
    [24, false],
    [25, false],
    [30, true],
  ])('streak %i milestone: %s', (streak, expected) => {
    expect(isStreakMilestone(streak)).toBe(expected);
  });
});

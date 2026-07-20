import { describe, it, expect } from 'vitest';
import {
  calculateCategoryScore,
  calculateWeightedScore,
  calculateWeightedCategoryScore,
  SCORE_WEIGHTS,
  THEME_DISQUALIFY_THRESHOLD,
  THEME_GATE_THRESHOLD,
  THEME_GATE_MAX_SCORE,
} from './daily-challenge-scoring';
import type { Score } from './daily-challenge-scoring';

function makeScore(theme: number, aesthetic: number, humor: number, wittiness: number): Score {
  return { theme, aesthetic, humor, wittiness };
}

describe('calculateWeightedScore', () => {
  it('returns null (disqualified) when theme is 0', () => {
    expect(calculateWeightedScore(makeScore(0, 10, 10, 10))).toBeNull();
  });

  it('returns null (disqualified) when theme is 1', () => {
    expect(calculateWeightedScore(makeScore(1, 10, 10, 10))).toBeNull();
  });

  it('caps score at THEME_GATE_MAX_SCORE when theme is 2 (at disqualify boundary)', () => {
    const result = calculateWeightedScore(makeScore(2, 10, 10, 10));
    expect(result).not.toBeNull();
    expect(result).toBeLessThanOrEqual(THEME_GATE_MAX_SCORE);
  });

  it('caps score at THEME_GATE_MAX_SCORE when theme is 3', () => {
    const result = calculateWeightedScore(makeScore(3, 10, 10, 10));
    expect(result).not.toBeNull();
    expect(result).toBeLessThanOrEqual(THEME_GATE_MAX_SCORE);
  });

  it('does not cap score when theme is at gate threshold (4)', () => {
    const result = calculateWeightedScore(makeScore(4, 10, 10, 10));
    expect(result).not.toBeNull();
    // Weighted: 4*0.5 + 10*0.2 + 10*0.15 + 10*0.15 = 2 + 2 + 1.5 + 1.5 = 7.0
    expect(result).toBeCloseTo(7.0);
  });

  it('returns perfect 10.0 when all scores are 10', () => {
    const result = calculateWeightedScore(makeScore(10, 10, 10, 10));
    expect(result).toBeCloseTo(10.0);
  });

  it('returns 5.0 when only theme is 10 and others are 0', () => {
    const result = calculateWeightedScore(makeScore(10, 0, 0, 0));
    expect(result).toBeCloseTo(5.0);
  });

  it('weights sum to 1.0', () => {
    const sum =
      SCORE_WEIGHTS.theme + SCORE_WEIGHTS.aesthetic + SCORE_WEIGHTS.humor + SCORE_WEIGHTS.wittiness;
    expect(sum).toBeCloseTo(1.0);
  });

  it('correctly applies weights for mixed scores', () => {
    // theme=8, aesthetic=6, humor=4, wittiness=2
    // Weighted: 8*0.5 + 6*0.2 + 4*0.15 + 2*0.15 = 4 + 1.2 + 0.6 + 0.3 = 6.1
    const result = calculateWeightedScore(makeScore(8, 6, 4, 2));
    expect(result).toBeCloseTo(6.1);
  });

  it('uses correct threshold constants', () => {
    expect(THEME_DISQUALIFY_THRESHOLD).toBe(2);
    expect(THEME_GATE_THRESHOLD).toBe(4);
    expect(THEME_GATE_MAX_SCORE).toBe(5.0);
  });
});

describe('calculateCategoryScore (user-defined categories)', () => {
  it('averages arbitrary categories equally', () => {
    expect(calculateCategoryScore({ horror: 8, originality: 6 })).toBe(7);
    expect(calculateCategoryScore({ a: 10, b: 0 })).toBe(5);
  });

  it('clamps out-of-range LLM output and ignores NaN', () => {
    expect(calculateCategoryScore({ a: 12, b: -3 })).toBe(5); // clamps to 10 and 0
    expect(calculateCategoryScore({ a: 6, b: NaN })).toBe(6);
  });

  it('returns null when there are no categories', () => {
    expect(calculateCategoryScore({})).toBeNull();
  });
});

describe('calculateWeightedCategoryScore', () => {
  const cats = [
    { key: 'theme', label: 'Theme', weight: 50 },
    { key: 'humor', label: 'Humor', weight: 50 },
  ];
  it('weights by percentage', () => {
    expect(calculateWeightedCategoryScore({ Theme: 8, Humor: 4 }, cats)).toBeCloseTo(6);
  });
  it('disqualifies (null) when theme < 2 (matches daily rubric)', () => {
    expect(calculateWeightedCategoryScore({ Theme: 1, Humor: 10 }, cats)).toBeNull();
  });
  it('does NOT disqualify at exactly theme 2 (but caps at 5)', () => {
    expect(calculateWeightedCategoryScore({ Theme: 2, Humor: 10 }, cats)).toBe(5);
  });
  it('caps at 5 when theme < 4', () => {
    expect(calculateWeightedCategoryScore({ Theme: 3, Humor: 10 }, cats)).toBe(5);
  });
  it('clamps out-of-range category scores to 0-10', () => {
    expect(calculateWeightedCategoryScore({ Theme: 20, Humor: -5 }, cats)).toBeCloseTo(5);
  });
  it('matches score keys tolerant of case/whitespace drift from the LLM', () => {
    expect(calculateWeightedCategoryScore({ theme: 8, humor: 4 }, cats)).toBeCloseTo(6);
  });
});

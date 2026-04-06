import { describe, it, expect } from 'vitest';
import {
  calculateWeightedScore,
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

import { describe, it, expect } from 'vitest';
import {
  calculateCategoryScore,
  calculateWeightedScore,
  calculateWeightedCategoryScore,
  FIXED_JUDGING_CATEGORIES,
  isFixedJudgeScore,
  lookupCategoryScore,
  resolveDisplayScore,
  SCORE_WEIGHTS,
  THEME_DISQUALIFY_THRESHOLD,
  THEME_GATE_THRESHOLD,
  THEME_GATE_MAX_SCORE,
} from './daily-challenge-scoring';
import type { Score } from './daily-challenge-scoring';
import { DEFAULT_CATEGORY_ROWS } from '~/shared/constants/challenge.constants';

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

describe('FIXED_JUDGING_CATEGORIES', () => {
  it('weights total 100%', () => {
    expect(FIXED_JUDGING_CATEGORIES.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
  });

  it('matches the rows seeded onto new challenges', () => {
    const byKey = (rows: { key: string; weight: number }[]) =>
      Object.fromEntries(rows.map((c) => [c.key, c.weight]));
    expect(byKey(FIXED_JUDGING_CATEGORIES)).toEqual(byKey(DEFAULT_CATEGORY_ROWS));
  });

  // Summing in category order rather than the legacy theme/aesthetic/humor/wittiness order moves
  // results by up to ~2e-15 (float addition isn't associative) — 14 orders of magnitude below the
  // 0.1 the score is displayed and compared at.
  const FLOAT_TOLERANCE = 1e-9;

  it('scores the same as the pre-consolidation fixed formula across the whole 0-10 grid', () => {
    const legacy = (s: Score) => {
      if (s.theme < THEME_DISQUALIFY_THRESHOLD) return null;
      const weighted =
        s.theme * SCORE_WEIGHTS.theme +
        s.aesthetic * SCORE_WEIGHTS.aesthetic +
        s.humor * SCORE_WEIGHTS.humor +
        s.wittiness * SCORE_WEIGHTS.wittiness;
      return s.theme < THEME_GATE_THRESHOLD ? Math.min(weighted, THEME_GATE_MAX_SCORE) : weighted;
    };

    const diffs: string[] = [];
    for (let t = 0; t <= 10; t++)
      for (let a = 0; a <= 10; a++)
        for (let h = 0; h <= 10; h++)
          for (let w = 0; w <= 10; w++) {
            const s = makeScore(t, a, h, w);
            const got = calculateWeightedScore(s);
            const want = legacy(s);
            const same =
              got === null || want === null
                ? got === want
                : Math.abs(got - want) < FLOAT_TOLERANCE;
            if (!same) diffs.push(`${t}/${a}/${h}/${w}: ${got} vs ${want}`);
          }
    expect(diffs).toEqual([]);
  });

  it('clamps LLM output the legacy formula passed through unchecked', () => {
    // Legacy: 15*0.5 + 5*0.2 + 5*0.15 + 5*0.15 = 10.0
    expect(calculateWeightedScore(makeScore(15, 5, 5, 5))).toBeCloseTo(7.5);
    // Legacy returned NaN for a partial score object, which survives a `!== null` filter.
    expect(calculateWeightedScore({ theme: 8, aesthetic: 6 } as Score)).not.toBeNaN();
  });
});

describe('lookupCategoryScore', () => {
  it('reads a category value tolerant of case/whitespace drift', () => {
    expect(lookupCategoryScore({ 'The  Theme ': 7 }, 'the theme')).toBe(7);
  });

  it('clamps out-of-range values and reports 0 for a missing category', () => {
    expect(lookupCategoryScore({ Theme: 12 }, 'Theme')).toBe(10);
    expect(lookupCategoryScore({ Theme: -3 }, 'Theme')).toBe(0);
    expect(lookupCategoryScore({ Theme: 5 }, 'Humor')).toBe(0);
  });
});

describe('isFixedJudgeScore', () => {
  it('accepts the fixed daily-challenge key set', () => {
    expect(isFixedJudgeScore({ theme: 8, wittiness: 5, humor: 5, aesthetic: 7 })).toBe(true);
  });

  it('rejects creator-defined category keys', () => {
    expect(isFixedJudgeScore({ Theme: 9, Wittiness: 3, Humor: 3, Aesthetic: 9 })).toBe(false);
    expect(isFixedJudgeScore({ horror: 8, originality: 6 })).toBe(false);
  });
});

describe('resolveDisplayScore', () => {
  // Challenge 423's rubric — the case users reported as "the math doesn't add up".
  const cats = [
    { key: 'theme', label: 'Theme', weight: 60 },
    { key: 'wittiness', label: 'Wittiness', weight: 5 },
    { key: 'humor', label: 'Humor', weight: 5 },
    { key: 'aesthetic', label: 'Aesthetic', weight: 30 },
  ];

  it('applies the challenge weights instead of averaging the categories', () => {
    // 9*.60 + 3*.05 + 3*.05 + 9*.30 = 8.4 (the unweighted mean would be 6.0)
    expect(resolveDisplayScore({ Theme: 9, Wittiness: 3, Humor: 3, Aesthetic: 9 }, cats)).toBeCloseTo(
      8.4
    );
    // 8*.60 + 7*.05 + 6*.05 + 8*.30 = 7.85 (the unweighted mean would be 7.25)
    expect(resolveDisplayScore({ Theme: 8, Wittiness: 7, Humor: 6, Aesthetic: 8 }, cats)).toBeCloseTo(
      7.85
    );
  });

  it('ranks entries the same way the winner-selection job does', () => {
    const a = resolveDisplayScore({ Theme: 9, Wittiness: 3, Humor: 3, Aesthetic: 9 }, cats)!;
    const b = resolveDisplayScore({ Theme: 8, Wittiness: 7, Humor: 6, Aesthetic: 8 }, cats)!;
    expect(a).toBeGreaterThan(b);
    expect(a).toBeCloseTo(
      calculateWeightedCategoryScore({ Theme: 9, Wittiness: 3, Humor: 3, Aesthetic: 9 }, cats)!
    );
  });

  it('prefers the challenge weights even when the LLM emitted the fixed lowercase keys', () => {
    expect(resolveDisplayScore({ theme: 9, wittiness: 3, humor: 3, aesthetic: 9 }, cats)).toBeCloseTo(
      8.4
    );
  });

  it('applies the theme gate rules from the challenge rubric', () => {
    expect(resolveDisplayScore({ Theme: 1, Wittiness: 10, Humor: 10, Aesthetic: 10 }, cats)).toBeNull();
    expect(resolveDisplayScore({ Theme: 3, Wittiness: 10, Humor: 10, Aesthetic: 10 }, cats)).toBe(
      THEME_GATE_MAX_SCORE
    );
  });

  it('falls back to the fixed daily rubric when the challenge has no categories', () => {
    const score = makeScore(8, 6, 4, 2);
    expect(resolveDisplayScore(score)).toBeCloseTo(6.1);
    expect(resolveDisplayScore(score, null)).toBeCloseTo(6.1);
    expect(resolveDisplayScore(score, [])).toBeCloseTo(6.1);
  });

  it('falls back to an equal-weight average for category scores with no rubric', () => {
    expect(resolveDisplayScore({ horror: 8, originality: 6 })).toBe(7);
  });
});

import { describe, expect, it } from 'vitest';
import { NSFW_RATINGS, isMatureNsfwLevel, nsfwLevelLabel, ratingBreakdown } from './nsfw-rating';

describe('ratingBreakdown', () => {
  it('counts each rating mildest first, leaving out unrated and unknown levels', () => {
    expect(ratingBreakdown(['x', 'pg', undefined, 'na', 'r', 'x', 'PG13', 'bogus'])).toEqual([
      { rating: 'pg', label: 'PG', count: 1, mature: false },
      { rating: 'pg13', label: 'PG-13', count: 1, mature: false },
      { rating: 'r', label: 'R', count: 1, mature: true },
      { rating: 'x', label: 'X', count: 2, mature: true },
    ]);
  });
});

describe('nsfwLevelLabel', () => {
  it('reads the orchestrator header in any case', () => {
    expect(nsfwLevelLabel('PG13')).toBe('PG-13');
    expect(nsfwLevelLabel('na')).toBeUndefined();
  });
});

describe('isMatureNsfwLevel', () => {
  // Policy pin: matches the main app's `isMature` (src/shared/constants/orchestrator.constants.ts).
  it('counts R, X and XXX as mature', () => {
    expect(NSFW_RATINGS.filter(isMatureNsfwLevel)).toEqual(['r', 'x', 'xxx']);
  });

  it('flags R and above in any case', () => {
    expect(isMatureNsfwLevel('X')).toBe(true);
    expect(isMatureNsfwLevel('r')).toBe(true);
  });

  it('is false for milder, unrated and missing levels', () => {
    expect(isMatureNsfwLevel('pg13')).toBe(false);
    expect(isMatureNsfwLevel('na')).toBe(false);
    expect(isMatureNsfwLevel(null)).toBe(false);
    expect(isMatureNsfwLevel(undefined)).toBe(false);
  });
});

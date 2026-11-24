import { describe, expect, it } from 'vitest';
import { nsfwLevelLabel, ratingBreakdown } from './nsfw-rating';

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

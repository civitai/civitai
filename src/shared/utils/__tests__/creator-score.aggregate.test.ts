import { describe, expect, it } from 'vitest';
import { creatorAggregateScoreFromMeta } from '~/shared/utils/creator-score';

describe('creatorAggregateScoreFromMeta', () => {
  it('is the category sum when it exceeds the total', () => {
    expect(
      creatorAggregateScoreFromMeta({
        scores: { total: 100, models: 300, images: 50, reportsAgainst: -20 },
      })
    ).toBe(330);
  });

  it('is the total when the categories sum to less', () => {
    expect(creatorAggregateScoreFromMeta({ scores: { total: 900, models: 300 } })).toBe(900);
  });

  it('reads absent or malformed scores as 0', () => {
    expect(creatorAggregateScoreFromMeta(null)).toBe(0);
    expect(creatorAggregateScoreFromMeta({ scores: { total: 'x', models: Infinity } })).toBe(0);
  });
});

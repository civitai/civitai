import { describe, expect, it } from 'vitest';
import { creatorScoreFromMeta } from '~/shared/utils/creator-score';

describe('creatorScoreFromMeta', () => {
  it('reads the total score — the figure /user/account labels "Creator Score"', () => {
    expect(creatorScoreFromMeta({ scores: { total: 12345 } })).toBe(12345);
  });

  // The one test that pins the switch. Named for the decision, because a later reader has no way to
  // tell a deliberate change of field from a typo. Both keys populated and unequal, so it also
  // reddens under `total ?? models`, under summing the categories, and under max(total, models).
  it('ignores the per-category models score', () => {
    expect(creatorScoreFromMeta({ scores: { total: 53_143, models: 4_883 } })).toBe(53_143);
    expect(creatorScoreFromMeta({ scores: { models: 4_883 } })).toBe(0);
  });

  // Unlike the models score this replaced, `total` is legitimately negative: reportsAgainst is
  // -1000 per actioned violation and is one of the six summed categories. Pins the contract, not a
  // gate — every threshold in the codebase is >= 10,000, so clamping at 0 would be invisible there.
  it('passes a negative score through rather than clamping it', () => {
    expect(creatorScoreFromMeta({ scores: { total: -1_500 } })).toBe(-1_500);
  });

  // User.meta is JSON, so a string-typed score is possible. Refusing it keeps this in step with the
  // Creator Studio spoke, which enforces the same money gate against the same row.
  it('refuses a string score rather than coercing it', () => {
    expect(creatorScoreFromMeta({ scores: { total: '50000' } })).toBe(0);
  });

  it('treats missing, null, or non-numeric meta as a score of 0', () => {
    expect(creatorScoreFromMeta(undefined)).toBe(0);
    expect(creatorScoreFromMeta(null)).toBe(0);
    expect(creatorScoreFromMeta({})).toBe(0);
    expect(creatorScoreFromMeta({ scores: {} })).toBe(0);
    expect(creatorScoreFromMeta({ scores: { total: 'lots' } })).toBe(0);
    expect(creatorScoreFromMeta({ scores: { total: Infinity } })).toBe(0);
  });
});

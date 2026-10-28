import { describe, it, expect } from 'vitest';
import { estimateBuzzCost } from '~/server/games/daily-challenge/generative-content';

describe('estimateBuzzCost', () => {
  it('prices a gpt-6-luna fallback review in buzz', () => {
    // 4000 in @ $0.10/M + 500 out @ $0.50/M = 0.0004 + 0.00025 = $0.00065 -> 0.65 buzz
    const buzz = estimateBuzzCost('openai/gpt-6-luna', {
      promptTokens: 4000,
      completionTokens: 500,
    });
    expect(buzz).toBeCloseTo(0.65, 5);
  });
  it('returns 0 for unknown models', () => {
    expect(estimateBuzzCost('unknown/model', { promptTokens: 1000, completionTokens: 1000 })).toBe(
      0
    );
  });
});

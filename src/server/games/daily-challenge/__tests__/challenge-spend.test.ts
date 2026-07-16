import { describe, it, expect } from 'vitest';
import { estimateBuzzCost } from '~/server/games/daily-challenge/generative-content';

describe('estimateBuzzCost', () => {
  it('prices gpt-5-nano review in buzz', () => {
    // 4000 in @ $0.05/M + 500 out @ $0.40/M = 0.0002 + 0.0002 = $0.0004 -> 0.4 buzz
    const buzz = estimateBuzzCost('openai/gpt-5-nano', { promptTokens: 4000, completionTokens: 500 });
    expect(buzz).toBeCloseTo(0.4, 5);
  });
  it('prices gpt-4o-mini higher', () => {
    const buzz = estimateBuzzCost('openai/gpt-4o-mini', { promptTokens: 4000, completionTokens: 500 });
    expect(buzz).toBeGreaterThan(
      estimateBuzzCost('openai/gpt-5-nano', { promptTokens: 4000, completionTokens: 500 })
    );
  });
  it('returns 0 for unknown models', () => {
    expect(estimateBuzzCost('unknown/model', { promptTokens: 1000, completionTokens: 1000 })).toBe(0);
  });
});

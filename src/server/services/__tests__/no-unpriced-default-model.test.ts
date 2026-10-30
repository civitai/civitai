import { describe, expect, it } from 'vitest';
import {
  MODEL_BUZZ_RATES,
  estimateBuzzCost,
} from '~/server/games/daily-challenge/generative-content';
import { AI_MODELS } from '~/server/services/ai/openrouter';

// 🔴 `estimateBuzzCost` returns 0 for any model absent from MODEL_BUZZ_RATES — silently. GROK was
// the daily-challenge review model for 113 challenges and was never in the table, so every one of
// them recorded operationSpent = 0. The cost of that era is simply not in the database, and the
// only reason anyone noticed was the vendor bill. A default model with no rate is unmeasurable
// spend, not a rounding error.
describe('every default challenge model is priced', () => {
  // Every model generative-content.ts routes to when a call site passes no override.
  const DEFAULTS = [AI_MODELS.MIMO] as const;

  it.each(DEFAULTS)('%s has a MODEL_BUZZ_RATES entry', (model) => {
    expect(MODEL_BUZZ_RATES[model]).toBeDefined();
  });

  it.each(DEFAULTS)('%s reports non-zero spend for real usage', (model) => {
    const cost = estimateBuzzCost(model, { promptTokens: 10_000, completionTokens: 1_000 });
    expect(cost).toBeGreaterThan(0);
  });

  it('reports exactly 0 for an unpriced model — the failure mode this guards', () => {
    expect(
      estimateBuzzCost('vendor/not-in-the-table', {
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      })
    ).toBe(0);
  });

  it('rates are positive, so a typo cannot zero out a priced model', () => {
    for (const [model, rates] of Object.entries(MODEL_BUZZ_RATES)) {
      expect(rates.input, `${model} input`).toBeGreaterThan(0);
      expect(rates.output, `${model} output`).toBeGreaterThan(0);
    }
  });
});

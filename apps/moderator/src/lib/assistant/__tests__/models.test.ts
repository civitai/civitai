import { describe, expect, it } from 'vitest';
import { ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, estimateSpend, findModel } from '../models';

describe('estimateSpend', () => {
  it('prices each model at its own list price, input and output apart', () => {
    // 1M prompt + 1M completion tokens each: the totals are the per-million prices.
    const { usd, byModel } = estimateSpend([
      { model: 'z-ai/glm-5.3-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 },
      { model: 'stepfun/step-5-preview', promptTokens: 1_000_000, completionTokens: 0 },
    ]);
    expect(byModel.map((r) => r.label)).toEqual(['GLM 5.3 Flash', 'Step 5 Preview']);
    expect(byModel[0].usd).toBeCloseTo(0.048 + 0.16, 10);
    expect(byModel[1].usd).toBeCloseTo(1, 10);
    expect(usd).toBeCloseTo(0.048 + 0.16 + 1, 10);
  });

  it('leaves a model no longer listed unpriced and out of the total, rather than guessing', () => {
    const { usd, byModel } = estimateSpend([
      { model: 'retired/model', promptTokens: 5_000, completionTokens: 5_000 },
      { model: 'openai/gpt-6-luna', promptTokens: 0, completionTokens: 2_000_000 },
    ]);
    expect(byModel[0]).toMatchObject({ label: 'retired/model', usd: null });
    expect(usd).toBeCloseTo(1, 10);
  });
});

describe('the model list', () => {
  it('holds the default, and only distinct ids', () => {
    expect(findModel(DEFAULT_ASSISTANT_MODEL)).not.toBeNull();
    expect(new Set(ASSISTANT_MODELS.map((m) => m.id)).size).toBe(ASSISTANT_MODELS.length);
  });
});

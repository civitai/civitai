import { describe, expect, it } from 'vitest';
import { ASSISTANT_MODELS, DEFAULT_ASSISTANT_MODEL, estimateSpend, findModel } from '../models';

describe('estimateSpend', () => {
  it('prices each model at its own price, input and output apart', () => {
    // 1M prompt + 1M completion tokens each: the totals are the per-million prices.
    const prices = {
      'z-ai/glm-5.3-flash': { input: 0.2, output: 0.7 },
      'stepfun/step-5-preview': { input: 1, output: 3 },
    };
    const { usd, byModel } = estimateSpend(
      [
        { model: 'z-ai/glm-5.3-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 },
        { model: 'stepfun/step-5-preview', promptTokens: 1_000_000, completionTokens: 0 },
      ],
      prices
    );
    expect(byModel.map((r) => r.label)).toEqual(['GLM 5.3 Flash', 'Step 5 Preview']);
    expect(byModel[0].usd).toBeCloseTo(0.9, 10);
    expect(byModel[1].usd).toBeCloseTo(1, 10);
    expect(usd).toBeCloseTo(1.9, 10);
  });

  it('falls back to the release prices when given none', () => {
    const { usd } = estimateSpend([
      { model: 'openai/gpt-6-luna', promptTokens: 0, completionTokens: 2_000_000 },
    ]);
    expect(usd).toBeCloseTo(2 * findModel('openai/gpt-6-luna')!.price.output, 10);
  });

  it('leaves an unpriced model out of the total and says how much was left out', () => {
    const { usd, byModel, unpricedTokens } = estimateSpend([
      { model: 'retired/model', promptTokens: 5_000, completionTokens: 2_000 },
      { model: 'openai/gpt-6-luna', promptTokens: 0, completionTokens: 2_000_000 },
    ]);
    expect(byModel[0]).toMatchObject({ label: 'retired/model', usd: null });
    expect(usd).toBeCloseTo(1, 10);
    expect(unpricedTokens).toBe(7_000);
  });
});

describe('the model list', () => {
  it('holds the default, and only distinct ids', () => {
    expect(findModel(DEFAULT_ASSISTANT_MODEL)).not.toBeNull();
    expect(new Set(ASSISTANT_MODELS.map((m) => m.id)).size).toBe(ASSISTANT_MODELS.length);
  });
});

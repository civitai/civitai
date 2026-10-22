import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  capPrice,
  costUsd,
  estimateSpend,
  findModel,
} from '../models';

describe('estimateSpend', () => {
  it('prices each model at its own price, input and output apart', () => {
    // 1M prompt + 1M completion tokens each: the totals are the per-million prices.
    const prices = {
      'z-ai/glm-5.3-flash': { input: 0.2, output: 0.7, current: true },
      'z-ai/glm-5.3': { input: 1, output: 3, current: true },
    };
    const { usd, byModel, current } = estimateSpend(
      [
        { model: 'z-ai/glm-5.3-flash', promptTokens: 1_000_000, completionTokens: 1_000_000 },
        { model: 'z-ai/glm-5.3', promptTokens: 1_000_000, completionTokens: 0 },
      ],
      prices
    );
    expect(byModel.map((r) => r.label)).toEqual(['GLM 5.3 Flash', 'GLM 5.3']);
    expect(byModel[0].usd).toBeCloseTo(0.9, 10);
    expect(byModel[1].usd).toBeCloseTo(1, 10);
    expect(usd).toBeCloseTo(1.9, 10);
    expect(current).toBe(true);
  });

  it("falls back to the release prices when given none, and says they are not today's", () => {
    const { usd, current } = estimateSpend([
      { model: 'z-ai/glm-5.3', promptTokens: 0, completionTokens: 2_000_000 },
    ]);
    expect(usd).toBeCloseTo(2 * findModel('z-ai/glm-5.3')!.price.output, 10);
    expect(current).toBe(false);
  });

  it('is not current if any priced model used a release price', () => {
    const { current, byModel } = estimateSpend(
      [
        { model: 'z-ai/glm-5.3-flash', promptTokens: 1, completionTokens: 1 },
        { model: 'z-ai/glm-5.3', promptTokens: 1, completionTokens: 1 },
      ],
      {
        'z-ai/glm-5.3-flash': { input: 1, output: 1, current: true },
        'z-ai/glm-5.3': { input: 1, output: 1 },
      }
    );
    expect(byModel.map((r) => r.current)).toEqual([true, false]);
    expect(current).toBe(false);
  });

  it('leaves an unpriced model out of the total and says how much was left out', () => {
    const { usd, byModel, unpricedTokens } = estimateSpend([
      { model: 'retired/model', promptTokens: 5_000, completionTokens: 2_000 },
      { model: 'z-ai/glm-5.3', promptTokens: 0, completionTokens: 1_000_000 },
    ]);
    expect(byModel[0]).toMatchObject({ label: 'retired/model', usd: null });
    expect(usd).toBeCloseTo(findModel('z-ai/glm-5.3')!.price.output, 10);
    expect(unpricedTokens).toBe(7_000);
  });
});

describe('the model list', () => {
  it('holds the default, and only distinct ids', () => {
    expect(findModel(DEFAULT_ASSISTANT_MODEL)).not.toBeNull();
    expect(new Set(ASSISTANT_MODELS.map((m) => m.id)).size).toBe(ASSISTANT_MODELS.length);
  });
});

describe('capPrice', () => {
  const million = (model: string, prices = {}) => {
    const { price, source } = capPrice(model, prices);
    return { usd: costUsd(1_000_000, 1_000_000, price), source };
  };

  it('charges the list price when the live one reads lower', () => {
    expect(
      million('z-ai/glm-5.3-flash', {
        'z-ai/glm-5.3-flash': { input: 0, output: 0, current: true },
      })
    ).toEqual({ usd: 0.65, source: 'live' });
  });

  it('charges the live price when it is higher', () => {
    expect(
      million('z-ai/glm-5.3-flash', {
        'z-ai/glm-5.3-flash': { input: 1, output: 2, current: true },
      })
    ).toEqual({ usd: 3, source: 'live' });
  });

  it('ignores a price that was not read live', () => {
    expect(
      million('z-ai/glm-5.3-flash', { 'z-ai/glm-5.3-flash': { input: 5, output: 5 } })
    ).toEqual({ usd: 0.65, source: 'list' });
  });

  it('charges a model it cannot price at the dearest listed price, never $0', () => {
    expect(million('retired/model')).toEqual({ usd: 3.7, source: 'list' });
  });
});

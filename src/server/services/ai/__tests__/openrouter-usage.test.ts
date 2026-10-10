import { describe, it, expect } from 'vitest';
import { extractUsage } from '~/server/services/ai/openrouter';

describe('extractUsage', () => {
  it('maps OpenRouter usage to promptTokens/completionTokens', () => {
    const usage = extractUsage({ usage: { prompt_tokens: 1200, completion_tokens: 300 } });
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 300 });
  });
  it('returns zeros when usage is absent', () => {
    expect(extractUsage({})).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
  it('maps the SDK-parsed camelCase usage shape too', () => {
    const usage = extractUsage({ usage: { promptTokens: 50, completionTokens: 75 } });
    expect(usage).toEqual({ promptTokens: 50, completionTokens: 75 });
  });

  /**
   * The third spelling: `POST /api/alpha/decisions` (`services/ai/jev.ts`). It
   * lives here rather than in a sibling parser in that module — this function
   * exists precisely to absorb a new wire spelling, and a second copy is how the
   * next field lands in only one of the two.
   */
  describe('the decisions spelling, and `cost`', () => {
    it('maps input_tokens/output_tokens and the vendor-reported cost', () => {
      // The usage block of a real recorded 200.
      expect(
        extractUsage({ usage: { input_tokens: 470, output_tokens: 78, cost: 1.974e-5 } })
      ).toEqual({ promptTokens: 470, completionTokens: 78, costUsd: 1.974e-5 });
    });

    it('🔴 reports an ABSENT cost as absent, never as 0', () => {
      // "Free" and "not reported" are different facts and whatever meters this
      // has to tell them apart, so the key must not exist at all. `toEqual`
      // ignores undefined, which is why this asserts with `in`.
      const usage = extractUsage({ usage: { input_tokens: 1, output_tokens: 2 } });
      expect('costUsd' in usage).toBe(false);
    });

    it('keeps a genuine zero cost, which is NOT the same as absent', () => {
      const usage = extractUsage({ usage: { input_tokens: 1, output_tokens: 2, cost: 0 } });
      expect('costUsd' in usage).toBe(true);
      expect(usage.costUsd).toBe(0);
    });

    it('🔴 drops a NEGATIVE or non-finite cost rather than metering it', () => {
      // A money input by construction. Dropped to "not reported" rather than
      // thrown, so a nonsense cost figure cannot discard a result that otherwise
      // succeeded.
      for (const cost of [-5, Number.NaN, Number.POSITIVE_INFINITY, '0.01', null]) {
        const usage = extractUsage({ usage: { input_tokens: 1, output_tokens: 2, cost } });
        expect('costUsd' in usage, `cost=${String(cost)}`).toBe(false);
      }
    });

    it('🔴 pins the full three-way precedence, not just one pair', () => {
      // The existing case separates `prompt_tokens` from `input_tokens` only, so
      // swapping the 2nd and 3rd terms of the `??` chain survives it. Two points
      // pin the whole order.
      expect(
        extractUsage({ usage: { prompt_tokens: 1, promptTokens: 2, input_tokens: 3 } })
      ).toMatchObject({ promptTokens: 1 });
      expect(extractUsage({ usage: { promptTokens: 2, input_tokens: 3 } })).toMatchObject({
        promptTokens: 2,
      });
    });

    it('prefers the OpenAI spelling when a payload somehow carries both', () => {
      expect(
        extractUsage({
          usage: { prompt_tokens: 10, completion_tokens: 20, input_tokens: 99, output_tokens: 99 },
        })
      ).toEqual({ promptTokens: 10, completionTokens: 20 });
    });

    it('zeroes a non-numeric token count instead of passing it through', () => {
      expect(extractUsage({ usage: { prompt_tokens: 'lots' } })).toEqual({
        promptTokens: 0,
        completionTokens: 0,
      });
    });

    it('survives a null or absent response object', () => {
      expect(extractUsage(null)).toEqual({ promptTokens: 0, completionTokens: 0 });
      expect(extractUsage(undefined)).toEqual({ promptTokens: 0, completionTokens: 0 });
    });
  });
});

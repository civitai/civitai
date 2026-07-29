import { describe, it, expect } from 'vitest';
import { extractUsage } from '~/server/services/ai/openrouter';

describe('extractUsage', () => {
  it('maps OpenRouter usage to promptTokens/completionTokens', () => {
    const usage = extractUsage({ usage: { prompt_tokens: 1200, completion_tokens: 300 } } as any);
    expect(usage).toEqual({ promptTokens: 1200, completionTokens: 300 });
  });
  it('returns zeros when usage is absent', () => {
    expect(extractUsage({} as any)).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
  it('maps the SDK-parsed camelCase usage shape too', () => {
    const usage = extractUsage({ usage: { promptTokens: 50, completionTokens: 75 } } as any);
    expect(usage).toEqual({ promptTokens: 50, completionTokens: 75 });
  });
});

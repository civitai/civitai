import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { reviewWithFallback } from './review-fallback';

const { logToAxiom } = loggingMock;
const context = { challengeId: 1, imageId: 2, nsfwLevel: 8 };

describe('reviewWithFallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the default model review without calling the fallback', async () => {
    const run = vi.fn(async (model?: string) => ({ model: model ?? 'civitai/qwen3.8' }));

    const result = await reviewWithFallback({ run, fallbackModel: 'xiaomi/mimo-v2.5', context });

    expect(result.model).toBe('civitai/qwen3.8');
    expect(run).toHaveBeenCalledTimes(1);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('reviews with the fallback model when the default fails, and logs why', async () => {
    const run = vi.fn(async (model?: string) => {
      if (!model) throw new Error('Input image may violate our terms and services.');
      return { model };
    });

    const result = await reviewWithFallback({ run, fallbackModel: 'xiaomi/mimo-v2.5', context });

    expect(result.model).toBe('xiaomi/mimo-v2.5');
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'daily-challenge-review-fallback',
        ...context,
        fallbackModel: 'xiaomi/mimo-v2.5',
        error: 'Input image may violate our terms and services.',
      })
    );
  });

  it('throws the fallback error when both models fail', async () => {
    const run = vi.fn(async (model?: string) => {
      throw new Error(model ? 'Provider returned error' : 'Civitai LLM error 504');
    });

    await expect(
      reviewWithFallback({ run, fallbackModel: 'xiaomi/mimo-v2.5', context })
    ).rejects.toThrow('Provider returned error');
  });
});

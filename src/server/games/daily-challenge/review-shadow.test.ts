import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { reviewWithShadow } from './review-shadow';

const { logToAxiom } = loggingMock;

const review = (summary: string, model = 'xiaomi/mimo-v2.5') => ({
  score: { theme: 7, wittiness: 5, humor: 4, aesthetic: 8 },
  reaction: 'Like' as const,
  comment: `comment ${summary}`,
  summary,
  model,
});
const context = { challengeId: 1, imageId: 2, nsfwLevel: 1 };
const loggedEvent = async () => {
  await vi.waitFor(() => expect(logToAxiom).toHaveBeenCalledTimes(1));
  return logToAxiom.mock.calls[0][0];
};

describe('reviewWithShadow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the primary review and logs both models side by side', async () => {
    const run = vi.fn(async (model?: string) =>
      model ? review('shadow', model) : review('primary')
    );

    const result = await reviewWithShadow({
      run,
      shadow: { model: 'civitai/qwen3.8', sampleRate: 1 },
      context,
    });

    expect(result.summary).toBe('primary');
    expect(run).toHaveBeenCalledWith('civitai/qwen3.8');
    const event = await loggedEvent();
    expect(event).toMatchObject({
      type: 'daily-challenge-review-shadow',
      ...context,
      primary: { ok: true, model: 'xiaomi/mimo-v2.5', summary: 'primary' },
      shadow: { ok: true, model: 'civitai/qwen3.8', summary: 'shadow' },
    });
  });

  it('keeps the primary review when the shadow model fails', async () => {
    const run = vi.fn(async (model?: string) => {
      if (model) throw new Error('Civitai LLM error 503');
      return review('primary');
    });

    const result = await reviewWithShadow({
      run,
      shadow: { model: 'civitai/qwen3.8', sampleRate: 1 },
      context,
    });

    expect(result.summary).toBe('primary');
    const event = await loggedEvent();
    expect(event.shadow).toMatchObject({ ok: false, error: 'Civitai LLM error 503' });
  });

  it('still throws a primary failure, and logs the shadow result for that entry', async () => {
    const run = vi.fn(async (model?: string) => {
      if (!model) throw new Error('OpenRouter 429');
      return review('shadow');
    });

    await expect(
      reviewWithShadow({ run, shadow: { model: 'civitai/qwen3.8', sampleRate: 1 }, context })
    ).rejects.toThrow('OpenRouter 429');
    const event = await loggedEvent();
    expect(event.primary).toMatchObject({ ok: false, error: 'OpenRouter 429' });
    expect(event.shadow).toMatchObject({ ok: true, summary: 'shadow' });
  });

  it.each([null, { model: 'civitai/qwen3.8', sampleRate: 0 }])(
    'runs only the primary model when the shadow is %o',
    async (shadow) => {
      const run = vi.fn(async () => review('primary'));

      await reviewWithShadow({ run, shadow, context });

      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(undefined);
      expect(logToAxiom).not.toHaveBeenCalled();
    }
  );
});

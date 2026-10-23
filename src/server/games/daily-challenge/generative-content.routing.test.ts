import { beforeEach, describe, expect, it, vi } from 'vitest';

const { llm, router } = vi.hoisted(() => ({
  llm: { getJsonCompletion: vi.fn() },
  router: { getJsonCompletionWithUsage: vi.fn() },
}));
vi.mock('~/server/services/ai/civitai-llm', () => ({ civitaiLLM: llm }));
vi.mock('~/server/services/ai/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openrouter: router,
}));

import { getCompletionWithUsage } from './generative-content';
import { DEFAULT_REVIEW_MODEL } from './challenge-judge-routes';

describe('getCompletionWithUsage routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reviews default to the orchestrator-hosted Qwen 3.8', () => {
    expect(DEFAULT_REVIEW_MODEL).toBe('civitai/qwen3.8');
  });

  it('sends civitai/* models to the orchestrator client, not OpenRouter', async () => {
    llm.getJsonCompletion.mockResolvedValue({ ok: true });
    await getCompletionWithUsage('civitai/qwen3.8', [], 3);
    expect(llm.getJsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'civitai/qwen3.8' })
    );
    expect(router.getJsonCompletionWithUsage).not.toHaveBeenCalled();
  });

  it('keeps vendor models on OpenRouter', async () => {
    router.getJsonCompletionWithUsage.mockResolvedValue({ content: {}, usage: {} });
    await getCompletionWithUsage('xiaomi/mimo-v2.5', [], 0);
    expect(router.getJsonCompletionWithUsage).toHaveBeenCalled();
    expect(llm.getJsonCompletion).not.toHaveBeenCalled();
  });
});

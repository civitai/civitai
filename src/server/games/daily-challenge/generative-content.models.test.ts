import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { llm, router } = vi.hoisted(() => ({
  llm: { getJsonCompletion: vi.fn() },
  router: { getJsonCompletion: vi.fn(), getJsonCompletionWithUsage: vi.fn() },
}));
vi.mock('~/server/services/ai/civitai-llm', () => ({ civitaiLLM: llm }));
vi.mock('~/server/services/ai/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openrouter: router,
}));

import { generateCollectionDetails, generateWinners } from './generative-content';

const picks = {
  winners: [{ creatorId: 1, creator: 'a', reason: 'r' }],
  process: 'p',
  outcome: 'o',
};
const input = {
  entries: [{ creatorId: 1, creator: 'a', summary: 's', score: {} as never }],
  theme: 'theme',
  config: { prompts: { systemMessage: 'sys', winner: 'pick' } } as never,
};

describe('generateWinners model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('picks winners on civitai/qwen3.8 by default', async () => {
    llm.getJsonCompletion.mockResolvedValue(picks);

    const result = await generateWinners(input);

    expect(result.model).toBe('civitai/qwen3.8');
    expect(router.getJsonCompletionWithUsage).not.toHaveBeenCalled();
  });

  it('falls back to GPT-6 Luna on OpenRouter when the default model fails, and logs why', async () => {
    llm.getJsonCompletion.mockRejectedValue(new Error('Civitai LLM error 504'));
    router.getJsonCompletionWithUsage.mockResolvedValue({ content: picks, usage: {} });

    const result = await generateWinners(input);

    expect(result.model).toBe('openai/gpt-6-luna');
    expect(result.winners).toEqual(picks.winners);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'daily-challenge-winners-fallback',
        error: 'Civitai LLM error 504',
      })
    );
  });

  it('uses an explicitly requested model without falling back', async () => {
    router.getJsonCompletionWithUsage.mockRejectedValue(new Error('Provider returned error'));

    await expect(generateWinners({ ...input, model: 'xiaomi/mimo-v2.5' })).rejects.toThrow(
      'Provider returned error'
    );
    expect(llm.getJsonCompletion).not.toHaveBeenCalled();
  });
});

describe('content stages model', () => {
  beforeEach(() => vi.clearAllMocks());

  const collectionInput = {
    resource: { modelId: 1, title: 'title', creator: 'creator' },
    image: { id: 1, url: 'https://image.example/1.jpeg' },
    config: { prompts: { systemMessage: 'sys', collection: 'name it' } } as never,
  };

  it('generates on civitai/qwen3.8 by default', async () => {
    llm.getJsonCompletion.mockResolvedValue({ name: 'n', description: 'd' });

    await generateCollectionDetails(collectionInput);

    expect(llm.getJsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'civitai/qwen3.8' })
    );
    expect(router.getJsonCompletion).not.toHaveBeenCalled();
  });

  it('falls back to GPT-6 Luna when the default model fails', async () => {
    llm.getJsonCompletion.mockRejectedValue(new Error('Input image may violate our terms'));
    router.getJsonCompletion.mockResolvedValue({ name: 'n', description: 'd' });

    const result = await generateCollectionDetails(collectionInput);

    expect(result).toEqual({ name: 'n', description: 'd' });
    expect(router.getJsonCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai/gpt-6-luna' })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'daily-challenge-collection-fallback' })
    );
  });
});

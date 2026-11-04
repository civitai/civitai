import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import type * as OpenRouterSdk from '@openrouter/sdk';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@openrouter/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenRouterSdk>()),
  OpenRouter: class {
    chat = { send };
  },
}));

envMock.set({ OPENROUTER_API_KEY: 'test-key' });
const { openrouter } = await import('~/server/services/ai/openrouter');
const { reviewImage, REVIEW_TIMEOUT_MS } = await import(
  '~/server/services/ai/collection-review.service'
);

const replyWith = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

beforeEach(() => {
  send.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('reviewImage', () => {
  it('bounds every attempt of the collection review call with its timeout', async () => {
    send.mockResolvedValueOnce(replyWith('not json')).mockResolvedValueOnce(replyWith('{}'));

    await reviewImage({
      imageUrl: 'https://image.example/x.jpeg',
      prompt: 'p',
      model: 'm',
      systemPrompt: 's',
    });

    expect(send).toHaveBeenCalledTimes(2);
    for (const call of send.mock.calls) expect(call[1]).toEqual({ timeoutMs: REVIEW_TIMEOUT_MS });
  });
});

describe('getJsonCompletionWithUsage', () => {
  it('sets no timeout for a caller that did not ask for one', async () => {
    send.mockResolvedValueOnce(replyWith('{}'));

    await openrouter!.getJsonCompletionWithUsage({ messages: [{ role: 'user', content: 'x' }] });

    expect(send.mock.calls[0][1]).toBeUndefined();
  });
});

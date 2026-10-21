import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The trigger word check every training path applies, with the external classifier mocked. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null as { message: string } | null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));

import { assertTrainingTriggerWordAllowed } from '~/server/services/orchestrator/training/training-trigger-word-check';

const check = (triggerWord: string) =>
  assertTrainingTriggerWordAllowed({ triggerWord, log: { userId: 1, source: 'test' } });

describe('assertTrainingTriggerWordAllowed', () => {
  beforeEach(() => classifyPromptExternally.mockClear());

  it('lets a soft hit through when the classifier is clear', async () => {
    await expect(check('a dog peeing on a tree in the park')).resolves.toBeUndefined();
    // Labelled as neither a generation nor a remix in the classifier's metrics.
    expect(classifyPromptExternally).toHaveBeenCalledWith(expect.any(String), 'other');
  });

  it('refuses a hard hit without asking the classifier', async () => {
    await expect(check('8 year old girl')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('trigger word has been blocked'),
    });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('reads past invisible formatting characters inside a word', async () => {
    await expect(check('8 year o​ld girl')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses what the classifier flags, naming its categories', async () => {
    classifyPromptExternally.mockResolvedValueOnce({ categories: ['cat-a'], externalError: null });
    await expect(check('mystyle')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('cat-a'),
    });
  });

  it('passes when the classifier is down, as every other audit does', async () => {
    classifyPromptExternally.mockResolvedValueOnce({
      categories: [],
      externalError: { message: 'down' },
    });
    await expect(check('mystyle')).resolves.toBeUndefined();
  });
});

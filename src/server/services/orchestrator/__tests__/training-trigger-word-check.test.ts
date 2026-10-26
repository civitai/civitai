import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The trigger word check every training path applies, with the external classifier mocked. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null as { message: string } | null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));

const trainingMatchesModelRules = vi.hoisted(() => vi.fn(async (_run: unknown) => false));
vi.mock('~/server/services/text-scan/model-rules-training', () => ({ trainingMatchesModelRules }));

import { assertTrainingTriggerWordAllowed } from '~/server/services/orchestrator/training/training-trigger-word-check';

const check = (triggerWord: string) =>
  assertTrainingTriggerWordAllowed({ triggerWord, log: { userId: 1, source: 'test' } });

describe('assertTrainingTriggerWordAllowed', () => {
  beforeEach(() => {
    classifyPromptExternally.mockClear();
    trainingMatchesModelRules.mockClear();
  });

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

  describe('Model rules', () => {
    const MODEL = { id: 7, versionId: 11, meta: null };

    it('refuses a match with a message that names neither the rule nor the term', async () => {
      trainingMatchesModelRules.mockResolvedValueOnce(true);
      const error = await check('herotw').catch((e) => e);
      expect(error).toMatchObject({ code: 'BAD_REQUEST' });
      expect(error.message).toContain("can't be started");
      expect(error.message).not.toContain('herotw');
    });

    it('asks after the word list and before the classifier', async () => {
      trainingMatchesModelRules.mockResolvedValueOnce(true);
      await expect(check('mystyle')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(classifyPromptExternally).not.toHaveBeenCalled();

      await expect(check('8 year old girl')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(trainingMatchesModelRules).toHaveBeenCalledTimes(1);
    });

    it('hands the draft model and the run to the check', async () => {
      await assertTrainingTriggerWordAllowed({
        triggerWord: 'mystyle',
        log: { userId: 1, source: 'trainer' },
        model: MODEL,
      });
      expect(trainingMatchesModelRules).toHaveBeenCalledWith({
        triggerWord: 'mystyle',
        userId: 1,
        source: 'trainer',
        model: MODEL,
      });
    });
  });
});

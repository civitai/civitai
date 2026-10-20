import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The text rule every training path applies, with the external classifier mocked. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null as { message: string } | null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));

import { assertTrainingTextAllowed } from '~/server/services/orchestrator/training/training-label-check';
import { MAX_AUDIT_PROMPT_LENGTH } from '~/utils/metadata/audit';

const check = ([triggerWord, ...captions]: string[]) =>
  assertTrainingTextAllowed({ triggerWord, captions, log: { userId: 1, source: 'test' } });

describe('assertTrainingTextAllowed', () => {
  beforeEach(() => classifyPromptExternally.mockClear());

  it('lets a soft hit through when the classifier is clear', async () => {
    await expect(
      check(['mystyle', 'mystyle, a dog peeing on a tree in the park'])
    ).resolves.toEqual({ classifierFailed: false });
    expect(classifyPromptExternally).toHaveBeenCalledTimes(1);
    // Labelled as neither a generation nor a remix in the classifier's metrics.
    expect(classifyPromptExternally).toHaveBeenCalledWith(expect.any(String), 'other');
  });

  it('passes when the classifier is down, and says so', async () => {
    classifyPromptExternally.mockResolvedValueOnce({
      categories: [],
      externalError: { message: 'down' },
    });
    await expect(check(['mystyle', 'mystyle, a cat'])).resolves.toEqual({ classifierFailed: true });
  });

  it('refuses a hard hit without asking the classifier', async () => {
    await expect(check(['mystyle', 'mystyle, 8 year old girl'])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('checks every caption of a large dataset, not only the first', async () => {
    const clean = Array.from({ length: 450 }, (_, i) => `mystyle, landscape ${i}, `.repeat(20));
    await expect(check(clean)).resolves.toEqual({ classifierFailed: false });

    const late = [...clean];
    late[420] = 'mystyle, 8 year old girl';
    await expect(check(late)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('reads past invisible formatting characters inside a word', async () => {
    await expect(check(['mystyle', 'mystyle, 8 year o\u200bld girl'])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('checks a trigger word on its own, with no captions', async () => {
    await expect(check(['8 year old girl'])).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a caption longer than the classifier is ever sent', async () => {
    await expect(check(['mystyle', 'a, '.repeat(MAX_AUDIT_PROMPT_LENGTH)])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('too long'),
    });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('refuses what the classifier flags, naming its categories', async () => {
    classifyPromptExternally.mockResolvedValueOnce({ categories: ['cat-a'], externalError: null });
    await expect(check(['mystyle', 'mystyle, 1girl'])).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('cat-a'),
    });
  });

  it('sends every caption to the classifier once, in batches it accepts', async () => {
    const captions = Array.from({ length: 60 }, (_, i) => `mystyle, landscape ${i} `.repeat(30));
    await check(captions);

    const sent = classifyPromptExternally.mock.calls.map(([prompt]) => prompt);
    expect(sent.length).toBeGreaterThan(1);
    for (const batch of sent) expect(batch.length).toBeLessThanOrEqual(MAX_AUDIT_PROMPT_LENGTH);
    expect(sent.join('\n')).toBe(captions.map((c) => c.trim()).join('\n'));
  });
});

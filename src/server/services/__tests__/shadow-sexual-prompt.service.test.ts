import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as Orchestrator from '~/server/services/orchestrator/orchestrator.service';

const { isFlipt, createXGuardModerationRequest } = vi.hoisted(() => ({
  isFlipt: vi.fn(),
  createXGuardModerationRequest: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Orchestrator>()),
  createXGuardModerationRequest,
}));

import { NsfwLevel } from '~/server/common/enums';
import {
  countsAsSexualPrompt,
  hashPromptPair,
  readShadowSexualPromptMetadata,
  submitShadowSexualPromptScan,
  wouldNsfwLevel,
} from '~/server/services/shadow-sexual-prompt.service';

const PROMPT = 'a still life of a contract on a desk';
const image = (meta: unknown, extra: Partial<{ type: string; nsfwLevel: number }> = {}) => ({
  id: 4242,
  type: 'image',
  nsfwLevel: NsfwLevel.PG,
  meta,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  isFlipt.mockResolvedValue(true);
  createXGuardModerationRequest.mockResolvedValue({ id: 'wf-1' });
});

describe('submitShadowSexualPromptScan', () => {
  it('submits nothing while the flag is off for the image', async () => {
    isFlipt.mockResolvedValue(false);
    await submitShadowSexualPromptScan(image({ prompt: PROMPT }));

    expect(isFlipt).toHaveBeenCalledWith('shadow-sexual-prompt', '4242');
    expect(createXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['no meta', null],
    ['no prompt', { negativePrompt: 'nude' }],
    ['a blank prompt', { prompt: '   ' }],
  ])('submits nothing for %s', async (_, meta) => {
    await submitShadowSexualPromptScan(image(meta));
    expect(createXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('submits nothing for a video', async () => {
    await submitShadowSexualPromptScan(image({ prompt: PROMPT }, { type: 'video' }));
    expect(createXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('submits one entity-less Sexual prompt scan whose marker the callback recognises', async () => {
    await submitShadowSexualPromptScan(
      image(
        { prompt: PROMPT, negativePrompt: 'blurry', civitaiResources: [] },
        { nsfwLevel: NsfwLevel.PG13 }
      )
    );

    expect(createXGuardModerationRequest).toHaveBeenCalledTimes(1);
    const args = createXGuardModerationRequest.mock.calls[0][0];
    expect(args).toMatchObject({
      mode: 'prompt',
      positivePrompt: PROMPT,
      negativePrompt: 'blurry',
      labels: ['Sexual'],
      priority: 'low',
      recordForReview: false,
    });
    expect(args.entityType).toBeUndefined();
    expect(args.entityId).toBeUndefined();

    expect(readShadowSexualPromptMetadata({ shadow: args.shadow })).toEqual({
      kind: 'sexual-prompt',
      imageId: 4242,
      currentNsfwLevel: NsfwLevel.PG13,
      onSite: true,
      promptHash: hashPromptPair(PROMPT, 'blurry'),
    });
    expect(JSON.stringify(args.shadow)).not.toContain(PROMPT);
  });

  it('marks a prompt from an off-site tool as not on-site', async () => {
    await submitShadowSexualPromptScan(
      image({ prompt: PROMPT, civitaiResources: [], Version: 'v1.10' })
    );
    expect(createXGuardModerationRequest.mock.calls[0][0].shadow.onSite).toBe(false);
  });
});

describe('hashPromptPair', () => {
  it('distinguishes the negative prompt, and treats none as empty', () => {
    expect(hashPromptPair(PROMPT, 'a')).not.toBe(hashPromptPair(PROMPT, 'b'));
    expect(hashPromptPair(PROMPT, undefined)).toBe(hashPromptPair(PROMPT, ''));
    expect(hashPromptPair(PROMPT, undefined)).not.toBe(hashPromptPair(`${PROMPT} `, undefined));
  });
});

describe('readShadowSexualPromptMetadata', () => {
  it.each([
    ['no metadata', undefined],
    ['no marker', { mode: 'prompt' }],
    [
      'another kind',
      {
        shadow: {
          kind: 'other',
          imageId: 1,
          currentNsfwLevel: 1,
          onSite: false,
          promptHash: 'a'.repeat(64),
        },
      },
    ],
    [
      'a missing image id',
      {
        shadow: {
          kind: 'sexual-prompt',
          currentNsfwLevel: 1,
          onSite: false,
          promptHash: 'a'.repeat(64),
        },
      },
    ],
  ])('is null for %s', (_, metadata) => {
    expect(readShadowSexualPromptMetadata(metadata as Record<string, unknown>)).toBeNull();
  });
});

describe('the rating the rule would set', () => {
  it.each([
    [NsfwLevel.PG, true, 'Positive Prompt', NsfwLevel.R],
    [NsfwLevel.PG13, true, 'Combined Prompt', NsfwLevel.R],
    [NsfwLevel.X, true, 'Positive Prompt', NsfwLevel.X],
    [NsfwLevel.PG, true, 'Negative Prompt', NsfwLevel.PG],
    [NsfwLevel.PG13, false, 'Positive Prompt', NsfwLevel.PG13],
    [NsfwLevel.PG, true, null, NsfwLevel.R],
  ])('level %i, triggered %s on %s -> %i', (current, triggered, field, expected) => {
    expect(wouldNsfwLevel(current, countsAsSexualPrompt({ triggered, field }))).toBe(expected);
  });
});

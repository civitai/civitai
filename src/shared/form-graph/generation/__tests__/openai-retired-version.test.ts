import { describe, expect, it } from 'vitest';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import {
  openaiModeVersionOptions,
  openaiVersionIds,
} from '~/shared/form-graph/generation/image/openai.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { substitutionsFromNotes } from '~/shared/generation/model-substitution';

/**
 * OpenAI shut off gpt-image-1 (version 1733399). Old remixes and saved forms still carry that
 * id, and OpenAI is model-locked: without the retired-version remap the locked clamp sends them
 * to the v2 default instead of 1.5, a different variant with no transparency toggle.
 */
const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  gateRules: [],
};

const parseV1 = (workflow: string, extra: Record<string, unknown> = {}) =>
  generationHub.parse(
    {
      workflow,
      ecosystem: 'OpenAI',
      prompt: 'a cat',
      model: { id: openaiVersionIds.v1, model: { type: 'Checkpoint' } },
      ...extra,
    } as never,
    EXT as never
  );

describe('retired GPT Image v1', () => {
  it('is not offered in the version picker', () => {
    const ids = openaiModeVersionOptions.map((o) => o.value);
    expect(ids).not.toContain(openaiVersionIds.v1);
    expect(ids).toContain(openaiVersionIds['v1.5']);
  });

  it.each([
    ['txt2img', {}],
    ['img2img:edit', { images: [{ url: 'https://example.com/a.png', width: 1024, height: 1024 }] }],
  ])('a %s request carrying v1 resolves to v1.5, not the v2 default', (workflow, extra) => {
    const result = parseV1(workflow, extra);
    if (!result.success) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
    const state = result.state as { workflow?: string; model?: { id?: number } };
    expect(state.workflow).toBe(workflow);
    expect(state.model?.id).toBe(openaiVersionIds['v1.5']);
  });

  it('keeps the gpt1 settings a v1 remix carried', () => {
    const result = parseV1('txt2img', { transparent: true, aspectRatio: '3:2' });
    if (!result.success) throw new Error(`parse failed: ${JSON.stringify(result.errors)}`);
    const state = result.state as {
      openaiVariant?: string;
      transparent?: boolean;
      aspectRatio?: { value?: string };
    };
    expect(state.openaiVariant).toBe('gpt1');
    expect(state.transparent).toBe(true);
    expect(state.aspectRatio?.value).toBe('3:2');
  });

  it('records the remap as a model substitution', () => {
    const result = parseV1('txt2img');
    const events = substitutionsFromNotes(result.notes, {
      ecosystem: 'OpenAI',
      workflow: 'txt2img',
    });
    expect(events.at(-1)).toEqual({
      requested: openaiVersionIds.v1,
      applied: openaiVersionIds['v1.5'],
      ecosystem: 'OpenAI',
      workflow: 'txt2img',
    });
  });
});

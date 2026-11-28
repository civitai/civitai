import { describe, expect, it } from 'vitest';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GenerationHandlerCtx } from '../../orchestration-new.service';
import { mai, maiVersionIds } from '~/shared/form-graph/generation/image/mai.graph';
import { createMAIInput } from '../mai.handler';
import type { EcosystemData } from '../types';

const BASE: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const ctx = {
  airs: { getOrThrow: (id: number) => `urn:air:test:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

const image = (i: number) => ({ url: `https://example.com/${i}.png`, width: 1600, height: 900 });
const version = (id: number) => ({ id, model: { type: 'Checkpoint' } });

async function build(workflow: string, input: Record<string, unknown>) {
  const parsed = mai.parse({ prompt: 'a red fox', ...input }, {
    ...BASE,
    ecosystem: 'MAI',
    workflow,
  } as never);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  const steps = await createMAIInput({ ...(parsed.data as EcosystemData<'MAI'>), workflow }, ctx);
  return (steps[0] as { input: Record<string, unknown> }).input;
}

describe('mai.handler', () => {
  it('2.7 Flash creates at the picked size, doubled at 2K', async () => {
    const input = await build('txt2img', {
      model: version(maiVersionIds['2.7-flash']),
      aspectRatio: '16:9',
      resolution: '2K',
    });
    expect(input).toMatchObject({
      model: 'maiImage27',
      variant: 'flash',
      operation: 'createImage',
      resolution: '2K',
      width: 2720,
      height: 1536,
    });
    expect(input.aspectRatio).toBeUndefined();
  });

  it('2.7 edits up to five images and sends no output dimensions', async () => {
    const images = [0, 1, 2, 3, 4].map(image);
    const input = await build('img2img:edit', { model: version(maiVersionIds['2.7']), images });
    expect(input).toMatchObject({
      model: 'maiImage27',
      variant: 'standard',
      operation: 'editImage',
      resolution: '1K',
    });
    expect(input.images).toEqual(images.map((x) => x.url));
    expect(input.width).toBeUndefined();
  });

  it('2.5 edit sends only the first of several images', async () => {
    const images = [0, 1, 2].map(image);
    const input = await build('img2img:edit', { model: version(maiVersionIds['2.5']), images });
    expect(input.images).toEqual([images[0].url]);
  });

  it('2.5 keeps its aspect-ratio input and one cropped image', async () => {
    const created = await build('txt2img', {
      model: version(maiVersionIds['2.5']),
      aspectRatio: '21:9',
    });
    expect(created).toMatchObject({ model: 'maiImage', aspectRatio: '21:9' });
    expect(created.variant).toBeUndefined();

    const edited = await build('img2img:edit', {
      model: version(maiVersionIds['2.5']),
      images: [image(0)],
    });
    expect(edited).toMatchObject({
      model: 'maiImage',
      operation: 'editImage',
      aspectRatio: '16:9',
    });
  });
});

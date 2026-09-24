import { describe, expect, it } from 'vitest';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { reconcileSelectors } from '~/shared/form-graph/generation/reconcile';
import { mingAspectRatios, mingResolutions } from '~/shared/constants/ming.constants';
import { buildMingStep } from '../ecosystems/ming-input';

const ext: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};
const image = { url: 'https://example.com/reference.png', width: 1200, height: 800 };
const base = { workflow: 'txt2img', ecosystem: 'Ming', prompt: 'A teal poster', seed: 42 };
const parsers = {
  data: (input: Record<string, unknown>) => generationGraph.safeParse(input, ext),
  form: (input: Record<string, unknown>) => generationHub.parse(reconcileSelectors(input).raw, ext),
};

describe.each(Object.entries(parsers))('Ming %s graph and request', (_lane, parse) => {
  function data(input: Record<string, unknown> = {}) {
    const result = parse({ ...base, ...input });
    if (!result.success) throw new Error(JSON.stringify(result.errors));
    if (!('ecosystem' in result.data) || result.data.ecosystem !== 'Ming')
      throw new Error('Ming must remain selected');
    return result.data;
  }

  it('uses the built-in checkpoint without a model card or stale model ID', () => {
    const parsed = data({ model: { id: 123, baseModel: 'SD 1.5' } });
    expect(parsed).not.toHaveProperty('model');
    expect(buildMingStep(parsed)).toEqual({
      $type: 'imageGen',
      input: {
        engine: 'comfy',
        ecosystem: 'ming',
        model: 'design',
        operation: 'createImage',
        prompt: base.prompt,
        width: 1024,
        height: 1024,
        steps: 12,
        cfgScale: 1,
        seed: 42,
        quantity: 1,
        sampler: 'euler',
        scheduler: 'simple',
        outputFormat: 'jpeg',
      },
    });
  });

  it.each(mingResolutions)('sends supported dimensions for every %s aspect ratio', (resolution) => {
    for (const ratio of mingAspectRatios[resolution]) {
      const input = buildMingStep(data({ resolution, aspectRatio: ratio.value })).input;
      expect(input).toMatchObject({ width: ratio.width, height: ratio.height });
      for (const dimension of [ratio.width, ratio.height]) {
        expect(dimension % 16).toBe(0);
        expect(dimension).toBeGreaterThanOrEqual(256);
        expect(dimension).toBeLessThanOrEqual(2048);
      }
    }
  });

  it.each([1, 2, 3])('edits with %i references and a resolution budget', (count) => {
    const images = Array.from({ length: count }, (_, i) => ({
      ...image,
      url: `${image.url}?ref=${i}`,
    }));
    const parsed = data({
      workflow: 'img2img:edit',
      images,
      resolution: '2K',
      aspectRatio: '9:16',
      cfgScale: 2,
      steps: 24,
      negativePrompt: 'blurry',
      outputFormat: 'png',
    });
    expect(parsed).not.toHaveProperty('aspectRatio');
    const input = buildMingStep(parsed).input;
    expect(input).toMatchObject({
      operation: 'editImage',
      sampler: 'lcm',
      resolution: 2048,
      images: images.map((x) => x.url),
      cfgScale: 2,
      steps: 24,
      negativePrompt: 'blurry',
      outputFormat: 'png',
    });
    expect(input).not.toHaveProperty('width');
    expect(input).not.toHaveProperty('height');
  });

  it('discards edit references when switching back to text-to-image', () => {
    const parsed = data({ images: [image], resolution: '2K' });
    expect(parsed).not.toHaveProperty('images');
    expect(buildMingStep(parsed).input).not.toHaveProperty('images');
    expect(buildMingStep(parsed).input).toMatchObject({
      operation: 'createImage',
      width: 2048,
      height: 2048,
    });
  });

  it('requires an editing instruction and caps references at three', () => {
    expect(parse({ ...base, workflow: 'img2img:edit', images: [] }).success).toBe(false);
    expect(
      data({ workflow: 'img2img:edit', images: [image, image, image, image] }).images
    ).toHaveLength(3);
    expect(parse({ ...base, workflow: 'img2img:edit', images: [image], prompt: '' }).success).toBe(
      false
    );
  });

  it('retains Design LoRAs and excludes Layer and unrelated addons', () => {
    const resources = [
      { id: 11, baseModel: 'Ming Image Design 0.1', model: { type: 'LORA' }, strength: 0.75 },
      { id: 12, baseModel: 'Ming Image Design Layer 0.1', model: { type: 'LORA' }, strength: 0.5 },
      { id: 13, baseModel: 'SD 1.5', model: { type: 'LORA' }, strength: 1 },
    ];
    expect(data({ resources }).resources).toEqual([resources[0]]);
  });

  it('preserves structured prompts and tuned sampling settings', () => {
    const prompt = JSON.stringify({ text: 'HELLO', background: 'transparent', color: 'teal' });
    const parsed = data({
      prompt,
      cfgScale: 3,
      steps: 33,
      negativePrompt: 'blurry',
      outputFormat: 'png',
    });
    const loras = { 'urn:air:ming:lora:civitai:1@2': 0.75 };
    expect(buildMingStep(parsed, loras).input).toMatchObject({
      prompt,
      cfgScale: 3,
      steps: 33,
      negativePrompt: 'blurry',
      outputFormat: 'png',
      loras,
    });
    expect(buildMingStep(data({ negativePrompt: 'stale negative' })).input).not.toHaveProperty(
      'negativePrompt'
    );
  });
});

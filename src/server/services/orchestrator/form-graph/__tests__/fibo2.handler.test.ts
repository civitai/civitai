import { describe, expect, it } from 'vitest';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GenerationHandlerCtx } from '../../orchestration-new.service';
import { fibo2, fibo2VersionIds } from '~/shared/form-graph/generation/image/fibo2.graph';
import { createFibo2Input } from '../fibo2.handler';
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

const IMAGE = { url: 'https://example.com/a.png', width: 1024, height: 1024 };
const LORA = { id: 501, model: { type: 'LORA' }, strength: 0.8 };
const FINE_TUNE = { id: 777, model: { type: 'Checkpoint' } };
const DEV = { id: fibo2VersionIds.dev, model: { type: 'Checkpoint' } };
const TURBO = { id: fibo2VersionIds.turbo, model: { type: 'Checkpoint' } };

function parse(workflow: string, input: Record<string, unknown>) {
  return fibo2.parse({ prompt: 'a red fox', ...input }, {
    ...BASE,
    ecosystem: 'Fibo2',
    workflow,
  } as never);
}

async function build(workflow: string, input: Record<string, unknown>) {
  const parsed = parse(workflow, input);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  const steps = await createFibo2Input(
    { ...(parsed.data as EcosystemData<'Fibo2'>), workflow },
    ctx
  );
  return (steps[0] as { input: Record<string, unknown> }).input;
}

describe('fibo2.handler', () => {
  it('Dev creates at the picked size, with LoRAs', async () => {
    const input = await build('txt2img', { resources: [LORA], aspectRatio: '16:9' });
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'fibo2',
      model: 'dev',
      operation: 'createImage',
      loras: { 'urn:air:test:501': 0.8 },
    });
    expect(input.width as number).toBeGreaterThan(input.height as number);
    expect(input.images).toBeUndefined();
  });

  it('Turbo edits the images and drops LoRAs', async () => {
    const input = await build('img2img:edit', { images: [IMAGE], resources: [LORA] });
    expect(input).toMatchObject({
      model: 'editTurbo',
      operation: 'editImage',
      images: [IMAGE.url],
    });
    expect(input.loras).toBeUndefined();
  });

  it('an edit needs an image', () => {
    expect(parse('img2img:edit', { images: [] }).success).toBe(false);
  });

  // The licensing fee is charged by the checkpoint AIR, so the official weights are named too.
  it('names the checkpoint as diffusionModel, official or fine-tune', async () => {
    expect((await build('txt2img', { model: FINE_TUNE })).diffusionModel).toBe('urn:air:test:777');
    expect((await build('txt2img', { model: DEV })).diffusionModel).toBe(`urn:air:test:${DEV.id}`);
    expect((await build('img2img:edit', { images: [IMAGE] })).diffusionModel).toBe(
      `urn:air:test:${TURBO.id}`
    );
  });

  it('refuses to create with a Turbo fine-tune, which only edits', async () => {
    const turbo = { id: 888, baseModel: 'Fibo 2.0 Turbo', model: { type: 'Checkpoint' } };
    await expect(build('txt2img', { model: turbo })).rejects.toThrow(/can only edit/);
  });

  it('back on txt2img, Edit Turbo returns to Dev', async () => {
    expect((await build('txt2img', { model: TURBO })).model).toBe('dev');
  });

  // A picked checkpoint would be recorded as used on an edit it never ran.
  it('an edit always records the official Edit Turbo version, whatever model was picked', () => {
    const parsed = parse('img2img:edit', { model: FINE_TUNE, images: [IMAGE] });
    expect(parsed.success && (parsed.data as { model?: { id: number } }).model?.id).toBe(TURBO.id);
  });
});

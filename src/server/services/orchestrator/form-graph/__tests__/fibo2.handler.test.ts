import { describe, expect, it, vi } from 'vitest';
import type * as Fibo2Graph from '~/shared/form-graph/generation/image/fibo2.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GenerationHandlerCtx } from '../../orchestration-new.service';

const OFFICIAL = 1000;
let versionId: number | undefined = OFFICIAL;
vi.mock('~/shared/form-graph/generation/image/fibo2.graph', async (importOriginal) => {
  const actual = await importOriginal<typeof Fibo2Graph>();
  return {
    ...actual,
    get fibo2VersionId() {
      return versionId;
    },
  };
});

import { fibo2 } from '~/shared/form-graph/generation/image/fibo2.graph';
import { createFibo2Input, type Fibo2Data } from '../fibo2.handler';

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

// The graph is not in the hub until the official version exists, so parse it on its own.
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
  const steps = await createFibo2Input({ ...(parsed.data as Fibo2Data), workflow }, ctx);
  return (steps[0] as { input: Record<string, unknown> }).input;
}

describe('fibo2.handler', () => {
  it('txt2img runs dev at its own defaults, at the picked size, with LoRAs', async () => {
    const input = await build('txt2img', { resources: [LORA], aspectRatio: '16:9' });
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'fibo2',
      model: 'dev',
      operation: 'createImage',
      steps: 30,
      cfgScale: 5,
      loras: { 'urn:air:test:501': 0.8 },
    });
    expect(input.width as number).toBeGreaterThan(input.height as number);
    expect(input.images).toBeUndefined();
  });

  it('an edit runs editTurbo at its few-step defaults, sends the images and drops LoRAs', async () => {
    const input = await build('img2img:edit', { images: [IMAGE], resources: [LORA] });
    expect(input).toMatchObject({
      model: 'editTurbo',
      operation: 'editImage',
      steps: 4,
      cfgScale: 1,
      images: [IMAGE.url],
    });
    expect(input.loras).toBeUndefined();
  });

  it('an edit needs an image and sends at most 16', async () => {
    const images = (n: number) => Array.from({ length: n }, () => IMAGE);
    expect(parse('img2img:edit', { images: images(0) }).success).toBe(false);
    expect((await build('img2img:edit', { images: images(17) })).images).toHaveLength(16);
  });

  it('a fine-tune rides as diffusionModel on create; the official version and edits never do', async () => {
    expect((await build('txt2img', { model: FINE_TUNE })).diffusionModel).toBe('urn:air:test:777');
    const official = { id: OFFICIAL, model: { type: 'Checkpoint' } };
    expect((await build('txt2img', { model: official })).diffusionModel).toBeUndefined();
    expect(
      (await build('img2img:edit', { model: FINE_TUNE, images: [IMAGE] })).diffusionModel
    ).toBeUndefined();
  });

  // A checkpoint kept on an edit would be recorded as a used resource for an image it never ran.
  it('an edit carries no checkpoint', () => {
    const parsed = parse('img2img:edit', { model: FINE_TUNE, images: [IMAGE] });
    expect(parsed.success && 'model' in parsed.data && parsed.data.model).toBeFalsy();
  });

  it('refuses to build while the official version id is unset', async () => {
    versionId = undefined;
    try {
      await expect(build('txt2img', {})).rejects.toThrow(/official version id/);
    } finally {
      versionId = OFFICIAL;
    }
  });
});

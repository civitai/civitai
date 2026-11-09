import { describe, expect, it } from 'vitest';
import { fibo2 } from '~/shared/form-graph/generation/image/fibo2.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import type { GenerationHandlerCtx } from '../../orchestration-new.service';
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

// The graph is not in the hub until the official version exists, so parse it on its own.
async function build(workflow: string, input: Record<string, unknown>) {
  const parsed = fibo2.parse({ prompt: 'a red fox', ...input }, {
    ...BASE,
    ecosystem: 'Fibo2',
    workflow,
  } as never);
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  const steps = await createFibo2Input({ ...(parsed.data as Fibo2Data), workflow }, ctx);
  return (steps[0] as { input: Record<string, unknown> }).input;
}

describe('fibo2.handler', () => {
  it('txt2img runs dev at its own defaults, with LoRAs', async () => {
    const input = await build('txt2img', { resources: [LORA] });
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'fibo2',
      model: 'dev',
      operation: 'createImage',
      steps: 30,
      cfgScale: 5,
      loras: { 'urn:air:test:501': 0.8 },
    });
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
    expect(input.diffusionModel).toBeUndefined();
  });

  it('a fine-tune checkpoint rides as diffusionModel on create but never on edit', async () => {
    const model = { id: 777, model: { type: 'Checkpoint' } };
    expect((await build('txt2img', { model })).diffusionModel).toBe('urn:air:test:777');
    expect(
      (await build('img2img:edit', { model, images: [IMAGE] })).diffusionModel
    ).toBeUndefined();
  });
});

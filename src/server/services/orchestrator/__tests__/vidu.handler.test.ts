import { describe, expect, it } from 'vitest';

import { createViduInput } from '../form-graph/vidu.handler';
import { viduVersionIds } from '~/shared/generation/version-ids';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: {} as any,
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as GenerationHandlerCtx;

async function input(data: Record<string, unknown>) {
  const [step] = await createViduInput(data as any, ctx);
  return step.input as Record<string, unknown>;
}

const image = (n: number) => ({ url: `https://img/${n}.png`, width: 512, height: 512 });

describe('createViduInput — Q4', () => {
  it('emits an imageToVideo from the first image, without the ref2vid-only fields', async () => {
    const result = await input({
      ecosystem: 'Vidu',
      workflow: 'img2vid',
      model: { id: viduVersionIds.q4 },
      prompt: 'she turns to the camera',
      images: [image(1)],
      resolution: '1080p',
      duration: 8,
      seed: 42,
      quantity: 1,
    });

    expect(result).toEqual({
      engine: 'vidu-q4',
      operation: 'imageToVideo',
      prompt: 'she turns to the camera',
      image: 'https://img/1.png',
      resolution: '1080p',
      duration: 8,
      seed: 42,
      quantity: 1,
    });
  });

  it('refuses an imageToVideo with no starting image', async () => {
    await expect(
      input({ ecosystem: 'Vidu', workflow: 'img2vid', model: { id: viduVersionIds.q4 } })
    ).rejects.toThrow('starting image');
  });

  it('emits a referenceToVideo with every reference, ratio and audio toggle', async () => {
    const result = await input({
      ecosystem: 'Vidu',
      workflow: 'img2vid:ref2vid',
      model: { id: viduVersionIds.q4 },
      prompt: '[@reference_image_1] walks into [@reference_image_2]',
      images: [image(1), image(2)],
      aspectRatio: { value: '9:16' },
      resolution: '4K',
      duration: 1,
      enableAudio: true,
      quantity: 1,
    });

    expect(result).toMatchObject({
      engine: 'vidu-q4',
      operation: 'referenceToVideo',
      referenceImages: ['https://img/1.png', 'https://img/2.png'],
      aspectRatio: '9:16',
      resolution: '4K',
      duration: 1,
      enableAudio: true,
    });
    expect(result.image).toBeUndefined();
  });

  it("fills an empty ref2vid prompt with Q4's [@reference_image_N] placeholders", async () => {
    const result = await input({
      ecosystem: 'Vidu',
      workflow: 'img2vid:ref2vid',
      model: { id: viduVersionIds.q4 },
      images: [image(1), image(2)],
    });

    expect(result.prompt).toBe('[@reference_image_1],[@reference_image_2]');
  });

  it('leaves Q3 on its own engine', async () => {
    const result = await input({
      ecosystem: 'Vidu',
      workflow: 'img2vid',
      model: { id: viduVersionIds.q3 },
      images: [image(1)],
    });

    expect(result.engine).toBe('vidu-q3');
  });
});

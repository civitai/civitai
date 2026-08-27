import { describe, expect, it } from 'vitest';

import { createKrea2Input } from '../ecosystems/krea2.handler';
import { krea2VersionIds } from '~/shared/data-graph/generation/krea2-graph';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const airsByVersionId: Record<number, string> = {
  [krea2VersionIds.raw]: 'urn:air:krea2:checkpoint:civitai:2656567@3072329',
  [krea2VersionIds.turbo]: 'urn:air:krea2:checkpoint:civitai:2656567@3072332',
  [krea2VersionIds.large]: 'urn:air:krea2:checkpoint:civitai:2656567@2983022',
  9001: 'urn:air:krea2:lora:civitai:9000@9001',
};

const ctx = {
  airs: {
    getOrThrow: (id: number) => {
      const air = airsByVersionId[id];
      if (!air) throw new Error(`no air for ${id}`);
      return air;
    },
  },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

async function input(data: Record<string, unknown>) {
  const [step] = await createKrea2Input(data as Parameters<typeof createKrea2Input>[0], ctx);
  return step.input as Record<string, unknown>;
}

const editData = {
  ecosystem: 'Krea2',
  workflow: 'img2img:edit',
  prompt: 'give him a hat',
  quantity: 1,
  aspectRatio: { value: '1:1', width: 1024, height: 1024 },
  images: [{ url: 'https://example.com/a.png' }],
};

describe('createKrea2Input — img2img:edit', () => {
  it.each([
    ['turbo', krea2VersionIds.turbo],
    ['raw', krea2VersionIds.raw],
  ])('runs the comfy edit build on the %s base', async (_label, id) => {
    const result = await input({ ...editData, model: { id }, cfgScale: 1, steps: 8 });

    expect(result).toMatchObject({
      engine: 'comfy',
      ecosystem: 'krea2',
      model: 'edit',
      operation: 'editImage',
      diffusionModel: airsByVersionId[id],
      images: ['https://example.com/a.png'],
      prompt: 'give him a hat',
      width: 1024,
      height: 1024,
      cfgScale: 1,
      steps: 8,
    });
  });

  it('sends community loras alongside the base', async () => {
    const result = await input({
      ...editData,
      model: { id: krea2VersionIds.turbo },
      resources: [{ id: 9001, strength: 0.8 }],
    });

    expect(result.loras).toEqual({ [airsByVersionId[9001]]: 0.8 });
  });

  it('rejects an edit with no source image', async () => {
    await expect(
      input({ ...editData, model: { id: krea2VersionIds.turbo }, images: [] })
    ).rejects.toThrow(/image is required/);
  });

  it('rejects an edit with no base model to run on', async () => {
    await expect(input({ ...editData, model: undefined })).rejects.toThrow(
      /base model is required/
    );
  });

  it('ignores a stale FAL size tier rather than emitting a FAL edit', async () => {
    const result = await input({ ...editData, model: { id: krea2VersionIds.large } });

    expect(result.engine).toBe('comfy');
    expect(result.operation).toBe('editImage');
  });
});

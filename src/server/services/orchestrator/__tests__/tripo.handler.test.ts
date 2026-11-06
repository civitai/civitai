import { describe, expect, it } from 'vitest';

import { createTripoInput } from '../form-graph/model3d.handler';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: {} as any,
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as GenerationHandlerCtx;

const data = {
  ecosystem: 'Tripo',
  workflow: 'img2model3d',
  images: [{ url: 'https://x/source.png', width: 1024, height: 1024 }],
};

async function stepTypes(extra: Record<string, unknown>) {
  const steps = await createTripoInput({ ...data, ...extra } as any, ctx);
  return steps.map((step) => step.$type);
}

describe('createTripoInput', () => {
  it('chains the 2D preview render after a GLB generation', async () => {
    expect(await stepTypes({ quad: false })).toEqual(['polyGen', 'model3DPreview']);
  });

  // Quad output is FBX-only, which the preview renderer can't load.
  it('submits a quad generation without the preview step', async () => {
    expect(await stepTypes({ quad: true })).toEqual(['polyGen']);
  });
});

async function polyGenInput(extra: Record<string, unknown>) {
  const [step] = await createTripoInput({ ...data, ...extra } as any, ctx);
  return (step as { input: Record<string, unknown> }).input;
}

describe('createTripoInput — H3.1', () => {
  it('sends one image as imageTo3D and several as multiviewTo3D, in order', async () => {
    expect(await polyGenInput({ version: 'h3.1' })).toMatchObject({
      version: 'h3.1',
      operation: 'imageTo3D',
      imageUrl: 'https://x/source.png',
    });

    const views = ['front', 'left', 'back'].map((v) => ({ url: `https://x/${v}.png` }));
    expect(await polyGenInput({ version: 'h3.1', images: views })).toMatchObject({
      operation: 'multiviewTo3D',
      imageUrls: ['https://x/front.png', 'https://x/left.png', 'https://x/back.png'],
    });
  });

  it('sends a prompt for text-to-3D, with no image fields', async () => {
    const input = await polyGenInput({
      version: 'h3.1',
      workflow: 'txt2model3d',
      images: undefined,
      prompt: 'a treasure chest',
      seed: 42,
    });
    expect(input).toMatchObject({
      operation: 'textTo3D',
      prompt: 'a treasure chest',
      seed: 42,
      imageSeed: 42,
    });
    expect(input.textureAlignment).toBeUndefined();
  });

  it('maps the texture tiers onto the texture toggle and quality', async () => {
    expect(await polyGenInput({ version: 'h3.1', texture: 'no' })).toMatchObject({
      texture: false,
    });
    expect(await polyGenInput({ version: 'h3.1', texture: 'HD' })).toMatchObject({
      texture: true,
      textureQuality: 'detailed',
    });
  });

  it('keeps v2.5 on its own input', async () => {
    expect(await polyGenInput({ version: 'v2.5', texture: 'HD' })).toMatchObject({
      version: 'v2.5',
      imageUrl: 'https://x/source.png',
      texture: 'HD',
    });
  });
});

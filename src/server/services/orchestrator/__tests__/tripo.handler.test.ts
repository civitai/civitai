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

  it('sends v2.5 with its version for the default Tripo version', async () => {
    const [step] = await createTripoInput(data as any, ctx);
    expect((step as any).input).toMatchObject({
      version: 'v2.5',
      imageUrl: 'https://x/source.png',
    });
  });

  // Quad output is FBX-only, which the preview renderer can't load.
  it('submits a quad generation without the preview step', async () => {
    expect(await stepTypes({ quad: true })).toEqual(['polyGen']);
  });

  it('sends H3.1 multiview when the H3.1 version has several images', async () => {
    const [step] = await createTripoInput(
      {
        ...data,
        tripoVersion: 'h3.1',
        images: [...data.images, { url: 'https://x/side.png', width: 1024, height: 1024 }],
      } as any,
      ctx
    );
    expect((step as any).input).toMatchObject({ version: 'h3.1', operation: 'multiviewTo3D' });
  });

  it('submits an H3.1 quad generation without the preview step', async () => {
    expect(await stepTypes({ tripoVersion: 'h3.1', quad: true })).toEqual(['polyGen']);
  });
});

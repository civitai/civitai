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

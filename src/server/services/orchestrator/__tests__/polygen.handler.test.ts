import { describe, expect, it } from 'vitest';

import { createPolyGenInput } from '../form-graph/model3d.handler';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: {} as any,
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as GenerationHandlerCtx;

const image = (n: number) => ({ url: `https://x/${n}.png`, width: 1024, height: 1024 });

async function polyGenInput(data: Record<string, unknown>) {
  const [step] = await createPolyGenInput({ ecosystem: 'PolyGen', ...data } as any, ctx);
  return (step as any).input;
}

describe('createPolyGenInput — Meshy v7.1', () => {
  it('sends text-to-3D with the form mode', async () => {
    const input = await polyGenInput({
      workflow: 'txt2model3d',
      polygenVersion: 'v7.1',
      prompt: 'a chest',
      polygenMode: 'preview',
    });
    expect(input).toMatchObject({ version: 'v7.1', operation: 'textTo3D', mode: 'preview' });
  });

  it('sends multi-image for several starting images', async () => {
    const input = await polyGenInput({
      workflow: 'img2model3d',
      polygenVersion: 'v7.1',
      images: [image(1), image(2)],
    });
    expect(input).toMatchObject({
      version: 'v7.1',
      operation: 'multiImageTo3D',
      imageUrls: ['https://x/1.png', 'https://x/2.png'],
    });
  });
});

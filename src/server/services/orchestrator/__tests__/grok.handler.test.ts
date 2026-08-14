import { describe, expect, it, vi } from 'vitest';

// Mocked for the EXIT CODE, not the assertions — see ecosystems.test.ts.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import { createGrokImageInput } from '../ecosystems/grok.handler';
import { grokVersionIds } from '~/shared/data-graph/generation/version-ids';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: {} as any,
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as GenerationHandlerCtx;

async function input(data: Record<string, unknown>) {
  const [step] = await createGrokImageInput(data as any, ctx);
  return step.input as Record<string, unknown>;
}

describe('createGrokImageInput', () => {
  it('emits a v1.0 createImage without the v2-only fields', async () => {
    const result = await input({
      ecosystem: 'Grok',
      workflow: 'txt2img',
      model: { id: grokVersionIds['v1.0'] },
      prompt: 'a cat',
      quantity: 2,
      aspectRatio: { value: '16:9' },
    });

    expect(result).toMatchObject({
      engine: 'grok',
      version: 'v1.0',
      operation: 'createImage',
      aspectRatio: '16:9',
      quantity: 2,
    });
    expect(result.resolution).toBeUndefined();
    expect(result.quality).toBeUndefined();
  });

  it('emits a v2.0 createImage carrying resolution and quality', async () => {
    const result = await input({
      ecosystem: 'Grok',
      workflow: 'txt2img',
      model: { id: grokVersionIds['v2.0'] },
      prompt: 'a cat',
      quantity: 1,
      aspectRatio: { value: '1:1' },
      resolution: '2k',
      quality: 'medium',
    });

    expect(result).toMatchObject({
      engine: 'grok',
      version: 'v2.0',
      operation: 'createImage',
      aspectRatio: '1:1',
      resolution: '2k',
      quality: 'medium',
    });
  });

  it('emits a v2.0 editImage with the source image urls', async () => {
    const result = await input({
      ecosystem: 'Grok',
      workflow: 'img2img:edit',
      model: { id: grokVersionIds['v2.0'] },
      prompt: 'make it blue',
      quantity: 1,
      resolution: '1k',
      quality: 'low',
      images: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }],
    });

    expect(result).toMatchObject({
      engine: 'grok',
      version: 'v2.0',
      operation: 'editImage',
      resolution: '1k',
      quality: 'low',
      images: ['https://example.com/a.png', 'https://example.com/b.png'],
    });
  });

  it('emits a v1.0 editImage when v1.0 is selected with source images', async () => {
    const result = await input({
      ecosystem: 'Grok',
      workflow: 'img2img:edit',
      model: { id: grokVersionIds['v1.0'] },
      prompt: 'make it blue',
      quantity: 1,
      images: [{ url: 'https://example.com/a.png' }],
    });

    expect(result).toMatchObject({
      engine: 'grok',
      version: 'v1.0',
      operation: 'editImage',
      images: ['https://example.com/a.png'],
    });
  });
});

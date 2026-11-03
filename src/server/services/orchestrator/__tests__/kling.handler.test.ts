import { describe, expect, it } from 'vitest';

import { createKlingInput } from '../form-graph/kling.handler';
import { klingVersionIds } from '~/shared/generation/version-ids';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

async function input(data: Record<string, unknown>) {
  const [step] = await createKlingInput(data as any, ctx);
  return step.input as Record<string, unknown>;
}

const v4 = (overrides: Record<string, unknown>) => ({
  ecosystem: 'Kling',
  model: { id: klingVersionIds.v4 },
  klingVersion: 'v4',
  prompt: 'a robot waves',
  resolution: '1080p',
  duration: 12,
  ...overrides,
});

describe('createKlingInput — V4', () => {
  it('sends start and end frames as keyframes, not references', async () => {
    const result = await input(
      v4({
        workflow: 'img2vid:first-last',
        operation: 'imageToVideo',
        images: [{ url: 'https://x/start.png' }, { url: 'https://x/end.png' }],
      })
    );

    expect(result).toMatchObject({
      engine: 'kling-v4',
      operation: 'imageToVideo',
      sourceImage: 'https://x/start.png',
      endImage: 'https://x/end.png',
      resolution: '1080p',
      duration: 12,
    });
    expect(result.images).toBeUndefined();
  });

  it('sends reference images as references', async () => {
    const result = await input(
      v4({
        workflow: 'img2vid:ref2vid',
        operation: 'referenceToVideo',
        aspectRatio: { value: '21:9' },
        images: [{ url: 'https://x/a.png' }, { url: 'https://x/b.png' }],
      })
    );

    expect(result).toMatchObject({
      operation: 'referenceToVideo',
      aspectRatio: '21:9',
      images: ['https://x/a.png', 'https://x/b.png'],
    });
    expect(result.sourceImage).toBeUndefined();
  });

  it('edits send the source video and its reference images', async () => {
    const result = await input(
      v4({
        workflow: 'vid2vid:edit',
        operation: 'videoToVideoEdit',
        duration: undefined,
        video: { url: 'https://x/source.mp4' },
        images: [{ url: 'https://x/jacket.png' }],
      })
    );

    expect(result).toMatchObject({
      operation: 'videoToVideoEdit',
      videoUrl: 'https://x/source.mp4',
      images: ['https://x/jacket.png'],
    });
    expect(result.duration).toBeUndefined();
  });

  it('refuses an edit without a source video', async () => {
    await expect(
      input(v4({ workflow: 'vid2vid:edit', operation: 'videoToVideoEdit' }))
    ).rejects.toThrow(/source video/);
  });
});

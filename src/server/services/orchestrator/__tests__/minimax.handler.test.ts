import { describe, expect, it } from 'vitest';

import { createMiniMaxInput } from '../ecosystems/minimax.handler';
import {
  MINIMAX_DEFAULT_ASPECT_RATIO,
  minimaxComfyAspectRatios,
  minimaxVersionIds,
} from '~/shared/data-graph/generation/minimax-graph';
import type { GenerationHandlerCtx } from '../orchestration-new.service';

const ctx = {
  airs: { getOrThrow: (id: number) => `air:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

async function input(data: Record<string, unknown>) {
  const [step] = await createMiniMaxInput(data as any, ctx);
  return step.input as Record<string, unknown>;
}

/** The supported 720p entry for a ratio, as the picker would show it. */
const entry = (value: string) => {
  const found = minimaxComfyAspectRatios.find((option) => option.value === value);
  if (!found) throw new Error(`no supported entry for ${value}`);
  return { width: found.width, height: found.height };
};

/**
 * Derived rather than named, so removing a ratio from the supported list moves
 * these expectations with it instead of failing on a ratio that no longer exists.
 */
const widest = () => {
  const found = minimaxComfyAspectRatios.reduce((a, b) =>
    b.width / b.height > a.width / a.height ? b : a
  );
  return { width: found.width, height: found.height };
};

const comfyImg2Vid = (images: { url: string; width?: number; height?: number }[]) => ({
  ecosystem: 'MiniMaxH3',
  workflow: 'img2vid',
  model: { id: minimaxVersionIds.comfy },
  minimaxVariant: 'comfy',
  prompt: 'a cat wanders off',
  duration: 6,
  images,
});

describe('createMiniMaxInput — comfy image-to-video dimensions', () => {
  it('takes the framing from a landscape first frame', async () => {
    const result = await input(
      comfyImg2Vid([{ url: 'https://x/1.png', width: 1920, height: 1080 }])
    );

    expect(result).toMatchObject({ operation: 'imageToVideo', ...entry('16:9') });
  });

  it('takes the framing from a portrait first frame', async () => {
    const result = await input(
      comfyImg2Vid([{ url: 'https://x/1.png', width: 1080, height: 1920 }])
    );

    expect(result).toMatchObject(entry('9:16'));
  });

  it('takes the framing from a square first frame', async () => {
    const result = await input(comfyImg2Vid([{ url: 'https://x/1.png', width: 900, height: 900 }]));

    expect(result).toMatchObject(entry('1:1'));
  });

  // The "within reason" property: an extreme upload must not become extreme
  // dimensions — it snaps to the widest ratio the ecosystem actually supports.
  it('clamps an extreme panorama to the widest supported ratio', async () => {
    const result = await input(
      comfyImg2Vid([{ url: 'https://x/1.png', width: 5000, height: 400 }])
    );

    expect(result).toMatchObject(widest());
    expect(result.width).not.toBe(5000);
    expect(result.height).not.toBe(400);
  });

  it('clamps an extreme column to the tallest supported ratio', async () => {
    const result = await input(
      comfyImg2Vid([{ url: 'https://x/1.png', width: 400, height: 5000 }])
    );

    expect(result).toMatchObject(entry('9:16'));
  });

  // A frame can arrive without dimensions, and the picker is hidden on this
  // workflow — so the fallback is the only thing standing between that and a
  // request carrying no dimensions at all.
  it('falls back to the default ratio when the frame carries no dimensions', async () => {
    const result = await input(comfyImg2Vid([{ url: 'https://x/1.png' }]));

    expect(result).toMatchObject(entry(MINIMAX_DEFAULT_ASPECT_RATIO));
    expect(result.width).toBeTypeOf('number');
    expect(result.height).toBeTypeOf('number');
  });

  it('always emits dimensions the comfy backend accepts', async () => {
    const sources = [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 5000, height: 400 },
      { width: 640, height: 480 },
      { width: 1, height: 1 },
    ];

    for (const source of sources) {
      const result = await input(comfyImg2Vid([{ url: 'https://x/1.png', ...source }]));
      expect((result.width as number) % 32, `width for ${source.width}x${source.height}`).toBe(0);
      expect((result.height as number) % 32, `height for ${source.width}x${source.height}`).toBe(0);
    }
  });

  it('passes both frames through for the first/last workflow', async () => {
    const result = await input({
      ...comfyImg2Vid([
        { url: 'https://x/first.png', width: 1920, height: 1080 },
        { url: 'https://x/last.png', width: 1920, height: 1080 },
      ]),
      workflow: 'img2vid:first-last',
    });

    expect(result).toMatchObject({
      firstFrame: 'https://x/first.png',
      lastFrame: 'https://x/last.png',
      ...entry('16:9'),
    });
  });

  it('uses the selected aspect ratio for text-to-video, which has no frame', async () => {
    const result = await input({
      ecosystem: 'MiniMaxH3',
      workflow: 'txt2vid',
      model: { id: minimaxVersionIds.comfy },
      minimaxVariant: 'comfy',
      prompt: 'a cat wanders off',
      duration: 6,
      aspectRatio: { value: '9:16', ...entry('9:16') },
    });

    expect(result).toMatchObject(entry('9:16'));
    expect(result.firstFrame).toBeUndefined();
  });

  it('keeps the selected aspect ratio for reference-to-video', async () => {
    const result = await input({
      ecosystem: 'MiniMaxH3',
      workflow: 'img2vid:ref2vid',
      model: { id: minimaxVersionIds.comfy },
      minimaxVariant: 'comfy',
      prompt: 'a cat wanders off',
      duration: 6,
      aspectRatio: { value: '1:1', ...entry('1:1') },
      // A portrait reference must not override the explicit selection here.
      images: [{ url: 'https://x/ref.png', width: 1080, height: 1920 }],
    });

    expect(result).toMatchObject({ operation: 'referenceToVideo', ...entry('1:1') });
  });
});

describe('createMiniMaxInput — hosted API variant', () => {
  it('still defers framing to the provider with adaptive', async () => {
    const result = await input({
      ecosystem: 'MiniMaxH3',
      workflow: 'img2vid',
      model: { id: minimaxVersionIds['v1.0'] },
      minimaxVariant: 'api',
      prompt: 'a cat wanders off',
      duration: 6,
      images: [{ url: 'https://x/1.png', width: 1920, height: 1080 }],
    });

    expect(result).toMatchObject({
      engine: 'minimax-h3',
      aspectRatio: 'adaptive',
      firstFrameImage: 'https://x/1.png',
    });
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
  });
});

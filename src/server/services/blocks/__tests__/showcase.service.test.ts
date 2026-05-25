import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the showcase service. The interesting surface is the meta
 * extractor (lots of historical shapes for Image.meta in the wild) and
 * the de-dupe + reaction-sort pass.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    imageResourceNew: { findMany: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));
// Mock getEdgeUrl as identity so tests assert against the input urls.
vi.mock('~/client-utils/cf-images-utils', () => ({
  getEdgeUrl: (src: string) => src,
}));

import { getModelShowcaseImages } from '../showcase.service';

beforeEach(() => {
  mockDbRead.imageResourceNew.findMany.mockReset();
});

function imageRow(
  id: number,
  reactions: number,
  meta: unknown = {},
  over: Record<string, unknown> = {}
) {
  return {
    image: {
      id,
      url: `https://cdn/${id}.png`,
      width: 1024,
      height: 1024,
      meta,
      nsfwLevel: 1,
      metrics: [{ reactionCount: reactions }],
      ...over,
    },
  };
}

describe('getModelShowcaseImages', () => {
  it('orders by reactionCount desc and caps at 6', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 5),
      imageRow(2, 50),
      imageRow(3, 10),
      imageRow(4, 100),
      imageRow(5, 1),
      imageRow(6, 30),
      imageRow(7, 200),
      imageRow(8, 15),
    ]);
    const result = await getModelShowcaseImages(99);
    // Reaction counts: 7=200, 4=100, 2=50, 6=30, 8=15, 3=10, 1=5, 5=1.
    // Top 6 = [7, 4, 2, 6, 8, 3]; 1 and 5 fall off the cap.
    expect(result.map((i) => i.id)).toEqual([7, 4, 2, 6, 8, 3]);
  });

  it('de-dupes images that appear in multiple resource rows', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 10), // showed up under modelVersionId=99 directly
      imageRow(1, 10), // and also linked through a LoRA from the same model
      imageRow(2, 5),
    ]);
    const result = await getModelShowcaseImages(99);
    expect(result.map((i) => i.id)).toEqual([1, 2]);
  });

  it('falls back to 0 reactions when the image has no AllTime metric row', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([
      imageRow(1, 0, {}, { metrics: [] }), // no metric → treated as 0
      imageRow(2, 5),
    ]);
    const result = await getModelShowcaseImages(99);
    expect(result.map((i) => i.id)).toEqual([2, 1]);
  });

  it('returns empty array when no images match', async () => {
    mockDbRead.imageResourceNew.findMany.mockResolvedValue([]);
    const result = await getModelShowcaseImages(99);
    expect(result).toEqual([]);
  });

  describe('meta extraction', () => {
    async function getFirstMeta(meta: unknown) {
      mockDbRead.imageResourceNew.findMany.mockResolvedValue([imageRow(1, 10, meta)]);
      const [first] = await getModelShowcaseImages(99);
      return first;
    }

    it('pulls camelCase fields from a typical orchestrator-shaped meta', async () => {
      const result = await getFirstMeta({
        prompt: 'a cat',
        negativePrompt: 'blurry',
        cfgScale: 7,
        steps: 25,
        seed: 12345,
        sampler: 'Euler',
      });
      expect(result).toMatchObject({
        prompt: 'a cat',
        negativePrompt: 'blurry',
        cfgScale: 7,
        steps: 25,
        seed: 12345,
        sampler: 'Euler',
      });
    });

    it('accepts AUTOMATIC1111-style PascalCase + space-separated keys', async () => {
      const result = await getFirstMeta({
        prompt: 'a cat',
        'Negative prompt': 'blurry',
        'CFG scale': '7.5', // numeric string from older meta dumps
        Steps: 30,
        Seed: 999,
        Sampler: 'DPM++ 2M Karras',
      });
      expect(result.negativePrompt).toBe('blurry');
      expect(result.cfgScale).toBe(7.5);
      expect(result.steps).toBe(30);
      expect(result.seed).toBe(999);
      expect(result.sampler).toBe('DPM++ 2M Karras');
    });

    it('rejects out-of-range / malformed values rather than passing them through', async () => {
      const result = await getFirstMeta({
        prompt: '   ', // whitespace-only → null
        cfgScale: 999, // out of range
        steps: 3.5, // non-int
        seed: 'not a number',
        sampler: 42, // wrong type
      });
      expect(result.prompt).toBeNull();
      expect(result.cfgScale).toBeNull();
      expect(result.steps).toBeNull();
      expect(result.seed).toBeNull();
      expect(result.sampler).toBeNull();
    });

    it('returns all-null meta when Image.meta is null/missing/non-object', async () => {
      const a = await getFirstMeta(null);
      const b = await getFirstMeta('not an object');
      expect(a.prompt).toBeNull();
      expect(a.cfgScale).toBeNull();
      expect(b.prompt).toBeNull();
      expect(b.sampler).toBeNull();
    });
  });
});

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as S3Utils from '~/utils/s3-utils';

const h = vi.hoisted(() => ({ stored: [] as Buffer[] }));

// The store is the network; the fetch is stubbed below; the transform, sniff and measuring are real.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  uploadImageBufferToStore: vi.fn(async (bytes: Buffer) => {
    h.stored.push(bytes);
    return { key: '00000000-0000-4000-8000-000000000000', backend: 'backblaze' };
  }),
}));

import { stageGenerationOutputImage } from '~/server/services/blocks/block-image-upload.service';

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();

beforeEach(async () => {
  h.stored = [];
  const bytes = await png(400, 200);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('stageGenerationOutputImage transform', () => {
  it('stores the transformed bytes and measures them, not the orchestrator dimensions', async () => {
    const staged = await stageGenerationOutputImage({
      imageUrl: 'https://orchestration.civitai.com/blob/1',
      width: 400,
      height: 200,
      source: 'test',
      transform: (bytes) =>
        sharp(bytes).extract({ left: 0, top: 50, width: 400, height: 100 }).toBuffer(),
    });
    const stored = await sharp(h.stored[0]).metadata();
    expect({ width: stored.width, height: stored.height }).toEqual({ width: 400, height: 100 });
    expect({ width: staged.width, height: staged.height }).toEqual({ width: 400, height: 100 });
  });

  it('refuses a transform that returns something other than an image', async () => {
    await expect(
      stageGenerationOutputImage({
        imageUrl: 'https://orchestration.civitai.com/blob/1',
        width: null,
        height: null,
        source: 'test',
        transform: async () => Buffer.from('not an image'),
      })
    ).rejects.toThrow('not a supported image');
    expect(h.stored).toHaveLength(0);
  });
});

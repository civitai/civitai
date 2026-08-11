import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { validateListingImage } from '~/server/schema/blocks/app-listing.schema';
import { persistBlockUploadImageSchema } from '~/server/schema/blocks/block-image-upload.schema';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `blockImageUpload.persist` — DECLARED-vs-ACTUAL geometry (issue #3770).
 *
 * A row this proc creates is attachable as app-listing media: `loadValidatedImage`
 * gates attach on ownership, not on how the row was made, and the per-kind rules it
 * then applies (`validateListingImage`) read `Image.width` / `height` / `mimeType` /
 * `metadata.size`. Ingestion writes scan state only — it never re-derives geometry —
 * so persisting the uploader's declared values made every one of those rules
 * self-reported. These pin that the columns describe the stored bytes instead.
 *
 * Only the store accessor is replaced; the probe and its sharp decode run for real
 * against real image bytes.
 */

const { mockCreateImage } = vi.hoisted(() => ({
  mockCreateImage: vi.fn(async (..._a: unknown[]) => ({ id: 777 })),
}));
const { mockS3Send } = vi.hoisted(() => ({ mockS3Send: vi.fn() }));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (u: string) => `edge:${u}` }));
vi.mock('~/server/services/image.service', () => ({ createImage: mockCreateImage }));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mockS3Send },
    bucket: 'test-image-bucket',
    backend: 'backblaze' as const,
  }),
}));

const fixtureCache = new Map<string, Buffer>();
async function cachedFixture(key: string, make: () => Promise<Buffer>) {
  const hit = fixtureCache.get(key);
  if (hit) return hit;
  const made = await make();
  fixtureCache.set(key, made);
  return made;
}

function flatPng(width: number, height: number) {
  return cachedFixture(`png:${width}x${height}`, () =>
    sharp({ create: { width, height, channels: 3, background: { r: 8, g: 8, b: 8 } } })
      .png()
      .toBuffer()
  );
}
function flatGif(width: number, height: number) {
  return cachedFixture(`gif:${width}x${height}`, () =>
    sharp({ create: { width, height, channels: 3, background: { r: 8, g: 8, b: 8 } } })
      .gif()
      .toBuffer()
  );
}

/** Answer the probe's ranged GET. `totalSize` is what the store reports as the
 *  object's real length, which is how an oversize object is detected without
 *  downloading it — so that case needs no large fixture. */
function storeObject(bytes: Buffer, opts: { totalSize?: number } = {}) {
  const totalSize = opts.totalSize ?? bytes.byteLength;
  mockS3Send.mockResolvedValue({
    Body: { transformToByteArray: async () => new Uint8Array(bytes) },
    ContentRange: `bytes 0-${bytes.byteLength - 1}/${totalSize}`,
  });
}

async function persist(input: Record<string, unknown>, userId = CALLER) {
  const { persistBlockUploadImage } = await import('../block-image-upload.service');
  return persistBlockUploadImage({ input: input as never, userId });
}

function persistedRow() {
  const arg = mockCreateImage.mock.calls[0][0] as {
    type: string;
    width?: number;
    height?: number;
    mimeType?: string;
    metadata?: { size?: number };
  };
  return {
    type: arg.type,
    width: arg.width,
    height: arg.height,
    mimeType: arg.mimeType,
    sizeBytes: arg.metadata?.size ?? null,
  };
}

const CALLER = 42;
const KEY = '33333333-3333-4333-8333-333333333333';

/** Declares a shape that clears every cover bound: aspect 1.78, 800px wide. */
const DECLARED_COVER = {
  url: KEY,
  name: 'cover.png',
  width: 800,
  height: 450,
  mimeType: 'image/png',
};

/** The block-image byte cap this path probes with (40 MiB). */
const BLOCK_IMAGE_MAX_BYTES_EXPECTED = 40 * 1024 * 1024;

beforeEach(() => {
  mockCreateImage.mockReset().mockResolvedValue({ id: 777 });
  mockS3Send.mockReset();
});

describe('persistBlockUploadImage (measures the uploaded bytes)', () => {
  it('persists the ACTUAL dimensions, so the listing cover gate rejects a mismatched upload', async () => {
    // Premise: the DECLARED pair really does clear the gate the bytes cannot.
    expect(
      validateListingImage(
        { type: 'image', width: 800, height: 450, mimeType: 'image/png', sizeBytes: 4096 },
        'cover'
      )
    ).toEqual({ ok: true });

    // 200×200 bytes behind that declaration: square, and 440px short of the 640px
    // cover floor.
    storeObject(await flatPng(200, 200));

    await persist(DECLARED_COVER);

    expect(persistedRow()).toMatchObject({ width: 200, height: 200 });
    expect(validateListingImage(persistedRow(), 'cover')).toMatchObject({ ok: false });
  });

  it('NEGATIVE CONTROL: an honest upload still persists and still passes the gate', async () => {
    storeObject(await flatPng(800, 450));

    const res = await persist(DECLARED_COVER);

    expect(res).toEqual({ imageId: 777 });
    expect(persistedRow()).toMatchObject({ width: 800, height: 450, mimeType: 'image/png' });
    expect(validateListingImage(persistedRow(), 'cover')).toEqual({ ok: true });
  });

  it('persists the ACTUAL byte size, not the declared one', async () => {
    const bytes = await flatPng(800, 450);
    storeObject(bytes);

    await persist({ ...DECLARED_COVER, sizeBytes: 1 });

    expect(persistedRow().sizeBytes).toBe(bytes.byteLength);
  });

  it('derives the MIME from the bytes, not the declared content type', async () => {
    storeObject(await flatPng(800, 450));

    await persist({ ...DECLARED_COVER, mimeType: 'image/webp' });

    expect(persistedRow().mimeType).toBe('image/png');
  });

  it('measures an upload that declares nothing at all', async () => {
    storeObject(await flatPng(800, 450));

    await persist({ url: KEY });

    expect(persistedRow()).toMatchObject({ width: 800, height: 450, mimeType: 'image/png' });
  });

  it('reports a quarter-turned JPEG the way a renderer shows it', async () => {
    storeObject(
      await sharp({
        create: { width: 450, height: 800, channels: 3, background: { r: 8, g: 8, b: 8 } },
      })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer()
    );

    await persist(DECLARED_COVER);

    expect(persistedRow()).toMatchObject({ width: 800, height: 450, mimeType: 'image/jpeg' });
  });

  it('rejects a format outside the allowlist however it is declared', async () => {
    storeObject(await flatGif(800, 450));

    await expect(persist(DECLARED_COVER)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('"gif"'),
    });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects an upload whose bytes are not there', async () => {
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('NoSuchKey'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      })
    );

    await expect(persist(DECLARED_COVER)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects bytes that are not a decodable image', async () => {
    storeObject(Buffer.from('<!doctype html><html>not an image</html>'));

    await expect(persist(DECLARED_COVER)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects an object above the block-image byte cap without downloading it', async () => {
    storeObject(await flatPng(800, 450), { totalSize: BLOCK_IMAGE_MAX_BYTES_EXPECTED + 1 });

    await expect(persist(DECLARED_COVER)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('40 MiB'),
    });
    const command = mockS3Send.mock.calls[0][0] as { input: { Range?: string } };
    expect(command.input.Range).toBe(`bytes=0-${BLOCK_IMAGE_MAX_BYTES_EXPECTED}`);
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('a store outage is an INTERNAL error, not the uploader being blamed', async () => {
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } })
    );

    await expect(persist(DECLARED_COVER)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('still creates the row OWNED BY THE CALLER and WITHOUT skipIngestion', async () => {
    storeObject(await flatPng(800, 450));

    await persist(DECLARED_COVER, 99);

    const arg = mockCreateImage.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.userId).toBe(99);
    expect(arg.skipIngestion).toBeFalsy();
    expect('skipIngestion' in arg && arg.skipIngestion === true).toBe(false);
    expect(arg).toMatchObject({ url: KEY, type: 'image', name: 'cover.png' });
  });
});

describe('persistBlockUploadImageSchema', () => {
  it('accepts an upload that omits the measured fields', () => {
    expect(persistBlockUploadImageSchema.parse({ url: KEY })).toEqual({ url: KEY });
  });

  it('still accepts a client that sends them', () => {
    expect(persistBlockUploadImageSchema.parse(DECLARED_COVER)).toMatchObject({
      url: KEY,
      width: 800,
      height: 450,
    });
  });
});

import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MeasureUploadedImage from '~/server/services/blocks/measure-uploaded-image';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

/**
 * `OPEN_IMAGE_UPLOAD { bytes }` — the `blockUploadedAppId` stamp must SURVIVE the real
 * `createImage`. Provenance keys are server-owned: `createImage` drops every copy found in
 * `metadata` and writes one only from its `blockProvenance` argument. A persist path that put
 * the stamp in `metadata` would store an unstamped row, and a test that mocks `createImage`
 * would not notice. So here `createImage` and `persistBlockUploadImage` both run for real; the
 * fakes sit at the Prisma client (`dbMock`), the store probe, and the scan submit.
 */

vi.mock('~/server/utils/created-image-media-probe', () => ({
  probeCreatedImageMedia: vi.fn(async () => 'present'),
}));
// The default-ingestion path submits a scan; the submit is not under test.
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createImageIngestionRequest: vi.fn(async () => ({ data: {} })),
}));
// Measuring reads the stored object; its values are not under test. The bytes are what the
// embedded-meta read parses.
const h = vi.hoisted(() => ({ storedBytes: Buffer.alloc(0) }));
vi.mock('~/server/services/blocks/measure-uploaded-image', async (importOriginal) => ({
  ...(await importOriginal<typeof MeasureUploadedImage>()),
  measureUploadedImageWithBytes: vi.fn(async () => ({
    measured: { width: 800, height: 450, mimeType: 'image/png', sizeBytes: 4321, etag: null },
    bytes: h.storedBytes,
  })),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { persistBlockUploadImage } from '~/server/services/blocks/block-image-upload.service';
import { createImage } from '~/server/services/image.service';
import {
  A1111_PARAMETERS,
  pngWithTextChunks,
} from '~/server/services/blocks/__tests__/embedded-meta-images.fixture';

const KEY = '33333333-3333-4333-8333-333333333333';
const CALLER = 42;
const APP_ID = 'appblk-alpha';
const IMAGE_ID = 9_101;

/** The `metadata` column value of the one `Image` row written. */
function storedMetadata(): Record<string, unknown> | undefined {
  const calls = dbMock.dbWrite.image.create.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data.metadata as Record<string, unknown> | undefined;
}

/** The `meta` column value of the one `Image` row written. */
function storedMeta(): unknown {
  const calls = dbMock.dbWrite.image.create.mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][0].data.meta;
}

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.image.create.mockResolvedValue({ id: IMAGE_ID } as never);
  h.storedBytes = await pngWithTextChunks({ parameters: A1111_PARAMETERS });
});

describe('persistBlockUploadImage → real createImage', () => {
  it('an app bytes upload stores blockUploadedAppId = the verified appId', async () => {
    const result = await persistBlockUploadImage({
      input: { url: KEY } as never,
      userId: CALLER,
      uploadedByAppId: APP_ID,
    });

    expect(result).toEqual({ imageId: IMAGE_ID });
    const metadata = storedMetadata();
    expect(metadata?.blockUploadedAppId).toBe(APP_ID);
    // The other provenance key stays off the row.
    expect(metadata && 'blockPublishedAppId' in metadata).toBe(false);
    expect(metadata?.size).toBe(4321);
  });

  it('a viewer-picked upload stores no provenance key', async () => {
    await persistBlockUploadImage({ input: { url: KEY } as never, userId: CALLER });

    const metadata = storedMetadata();
    expect(metadata && 'blockUploadedAppId' in metadata).toBe(false);
    expect(metadata && 'blockPublishedAppId' in metadata).toBe(false);
    expect(metadata?.size).toBe(4321);
  });

  it('an app bytes upload stores the parameters embedded in the file as meta', async () => {
    await persistBlockUploadImage({
      input: { url: KEY } as never,
      userId: CALLER,
      uploadedByAppId: APP_ID,
    });

    expect(storedMeta()).toMatchObject({
      prompt: 'a lighthouse at dusk, oil painting',
      negativePrompt: 'blurry',
      steps: 24,
      seed: 1234567,
    });
  });

  it('a viewer-picked upload does not read embedded parameters', async () => {
    await persistBlockUploadImage({ input: { url: KEY } as never, userId: CALLER });

    expect(storedMeta()).toBe(Prisma.JsonNull);
  });
});

describe('createImage (default ingestion) with client metadata', () => {
  it('drops a client-supplied blockUploadedAppId and keeps the rest', async () => {
    await createImage({
      url: KEY,
      type: 'image',
      userId: CALLER,
      metadata: { size: 1, blockUploadedAppId: 'client-claimed-app' },
    } as never);

    expect(storedMetadata()).toEqual({ size: 1 });
  });
});

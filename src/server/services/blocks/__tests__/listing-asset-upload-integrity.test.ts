import { createHash } from 'crypto';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as S3Utils from '~/utils/s3-utils';

/**
 * Listing media — the upload measurement must still describe the stored object at
 * the moment it is RELIED UPON, not merely at the moment it was taken.
 *
 * `persistListingAssetImage` derives an `Image` row's width / height / MIME / byte
 * size from the bytes it reads back out of the store, precisely so those columns
 * are not a client claim. Every listing attach rule is expressed over exactly those
 * columns. But the upload grant for a key outlives that measurement, so between
 * persist and attach the object at the key can become different bytes while the row
 * keeps describing the old ones — at which point the attach gate is validating a
 * description rather than the media it is about.
 *
 * 🔴 THIS IS A SEAM TEST, and deliberately not two isolated ones. Persist WRITES an
 * integrity token into `Image.metadata` and attach READS it back; each half is
 * trivially "correct" on its own while the pair does nothing at all, if they
 * disagree about the metadata key or the comparison. So every case below runs the
 * REAL persist proc, takes the metadata blob it actually produced, puts THAT on the
 * row the REAL attach proc loads, and only then varies the store.
 *
 * The dimension every case varies is the identity of the stored object, and the
 * fixtures cross it in both directions: an untouched object attaches (proving the
 * guard is not a blanket reject), a replaced one does not.
 */

const { mockRead, mockWrite, mockCreateImage, mockS3Send } = vi.hoisted(() => {
  const db = {
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (..._a: unknown[]) => ({})),
    },
    image: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(db);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return {
    mockRead: db,
    mockWrite: db,
    mockCreateImage: vi.fn(async (..._a: unknown[]) => ({ id: 777 })),
    mockS3Send: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/image.service', () => ({ createImage: mockCreateImage }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => 'apl_test_1',
  newAppListingPublishRequestId: () => 'alpr_test_1',
  newAppListingModerationEventId: () => 'alme_test_1',
  newAppListingScreenshotId: () => 'apls_test_1',
}));
// Only the backend ACCESSOR is replaced. The probe, the `sharp` decode inside it,
// the head re-read and the comparison all run for real against real bytes.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mockS3Send },
    bucket: 'test-image-bucket',
    backend: 'backblaze' as const,
  }),
}));

// ---------------------------------------------------------------------------
// A minimal object store the real probe + the real head both talk to.
// ---------------------------------------------------------------------------

type StoredObject = { bytes: Buffer; etag: string | null };
const store = new Map<string, StoredObject>();
/** Set when a request should fail as infrastructure rather than as a miss. */
let storeOutage: Error | null = null;

/**
 * Entity tags are derived from the bytes, exactly as a real store derives them —
 * so two different fixtures cannot accidentally share one, and an "unchanged"
 * case cannot pass because both sides were handed the same literal.
 */
function etagOf(bytes: Buffer) {
  return `"${createHash('md5').update(bytes).digest('hex')}"`;
}

function putObject(key: string, bytes: Buffer, opts: { etag?: string | null } = {}) {
  store.set(key, { bytes, etag: opts.etag === undefined ? etagOf(bytes) : opts.etag });
}

function notFound() {
  return Object.assign(new Error('NoSuchKey'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
}

mockS3Send.mockImplementation(async (command: unknown) => {
  if (storeOutage) throw storeOutage;
  const key = (command as { input: { Key: string } }).input.Key;
  const object = store.get(key);
  if (!object) throw notFound();
  if (command instanceof HeadObjectCommand) {
    return { ETag: object.etag, ContentLength: object.bytes.byteLength };
  }
  if (command instanceof GetObjectCommand) {
    return {
      Body: { transformToByteArray: async () => new Uint8Array(object.bytes) },
      ContentRange: `bytes 0-${object.bytes.byteLength - 1}/${object.bytes.byteLength}`,
      ETag: object.etag,
    };
  }
  throw new Error(`unexpected S3 command: ${(command as object)?.constructor?.name}`);
});

const fixtureCache = new Map<string, Buffer>();
/** Real, decodable bytes — nothing about these images is declared. */
async function flatPng(width: number, height: number, shade: number) {
  const cacheKey = `${width}x${height}:${shade}`;
  const hit = fixtureCache.get(cacheKey);
  if (hit) return hit;
  const made = await sharp({
    create: { width, height, channels: 3, background: { r: shade, g: shade, b: shade } },
  })
    .png()
    .toBuffer();
  fixtureCache.set(cacheKey, made);
  return made;
}

const OWNER = 42;
const KEY = '44444444-4444-4444-8444-444444444444';
const LISTING = {
  id: 'apl_1',
  kind: 'onsite',
  slug: 's',
  name: 'n',
  category: null,
  contentRating: null,
  userId: OWNER,
  iconId: null,
  coverId: null,
};
const owner = { id: OWNER, isModerator: false } as never;

/**
 * Run the REAL persist proc over the object currently at `KEY` and return the
 * `Image.metadata` blob it produced — the seam's write side, unedited.
 */
async function persistAndCaptureMetadata() {
  mockCreateImage.mockClear();
  const { persistListingAssetImage } = await import('../offsite-listing.service');
  await persistListingAssetImage({
    input: { url: KEY, name: 'icon.png', width: 1, height: 1, mimeType: 'image/png' },
    userId: OWNER,
  } as never);
  expect(mockCreateImage).toHaveBeenCalledTimes(1);
  return (mockCreateImage.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;
}

/** The row the attach gate loads, carrying persist's own metadata verbatim. */
function rowWith(metadata: unknown, measured: { width: number; height: number }) {
  return {
    id: 500,
    userId: OWNER,
    url: KEY,
    type: 'image',
    width: measured.width,
    height: measured.height,
    mimeType: 'image/png',
    metadata,
    ingestion: 'Scanned',
    nsfwLevel: 1,
  };
}

async function attachAsIcon() {
  const { setListingIcon } = await import('../app-listing-assets.service');
  return setListingIcon({ listingId: 'apl_1', imageId: 500 }, owner);
}

beforeEach(() => {
  store.clear();
  fixtureCache.clear();
  storeOutage = null;
  mockRead.appListing.findUnique.mockReset().mockResolvedValue(LISTING);
  mockRead.appListing.findFirst.mockReset().mockResolvedValue(null);
  mockRead.appListing.update.mockReset().mockResolvedValue({});
  mockRead.image.findUnique.mockReset().mockResolvedValue(null);
  mockRead.image.findMany.mockReset().mockResolvedValue([]);
  mockCreateImage.mockReset().mockResolvedValue({ id: 777 });
});

describe('listing media — the persisted measurement is re-verified at attach', () => {
  it('records an integrity token derived from the bytes it measured', async () => {
    const original = await flatPng(512, 512, 8);
    putObject(KEY, original);

    const metadata = await persistAndCaptureMetadata();

    // Recorded, and recorded as the store's own token for THESE bytes — not some
    // value the caller supplied and not a constant.
    expect(metadata).toMatchObject({ size: original.byteLength });
    const { readRecordedEtag } = await import('../stored-object-integrity');
    expect(readRecordedEtag(metadata)).toBe(etagOf(original).replaceAll('"', ''));
  });

  it('attaches normally while the stored object is still the measured one', async () => {
    const original = await flatPng(512, 512, 8);
    putObject(KEY, original);
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 512 }));
    mockS3Send.mockClear();

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached', iconId: 500 });
    expect(mockRead.appListing.update).toHaveBeenCalled();

    // 🔴 POSITIVE CONTROL for REACHABILITY. The accept above must be the guard
    // running and agreeing, not the guard being skipped — those are the same
    // observable from the outside. So assert the head request was actually issued
    // against this key: with the check short-circuited, this count is 0.
    const heads = mockS3Send.mock.calls.filter(
      ([cmd]) => cmd instanceof HeadObjectCommand && (cmd as HeadObjectCommand).input.Key === KEY
    );
    expect(heads).toHaveLength(1);
  });

  /**
   * 🔴 THE REGRESSION. Same row, same columns, same caller — only the bytes behind
   * the key differ from the ones those columns were measured from. Before this
   * guard the attach succeeded and the listing was validated against geometry that
   * was no longer in the store.
   */
  it('REFUSES the attach once the stored object is no longer the measured one', async () => {
    const original = await flatPng(512, 512, 8);
    putObject(KEY, original);
    const metadata = await persistAndCaptureMetadata();
    const row = rowWith(metadata, { width: 512, height: 512 });
    mockRead.image.findUnique.mockResolvedValue(row);

    // The object is replaced; the row is NOT touched, so it still advertises the
    // original geometry and would satisfy every column rule unchanged.
    const replacement = await flatPng(160, 120, 200);
    putObject(KEY, replacement);
    expect(etagOf(replacement)).not.toBe(etagOf(original));

    await expect(attachAsIcon()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'that image has changed since it was uploaded — upload it again',
    });
    // Nothing was written — the listing never references the swapped object.
    expect(mockRead.appListing.update).not.toHaveBeenCalled();
  });

  it('refuses even when the replacement decodes to the SAME geometry', async () => {
    const original = await flatPng(512, 512, 8);
    putObject(KEY, original);
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 512 }));

    // Identical dimensions, different content. A geometry re-probe would say this
    // is fine; the question the gate asks is "are these the same bytes", not "do
    // they still measure the same".
    const sameShape = await flatPng(512, 512, 200);
    putObject(KEY, sameShape);

    await expect(attachAsIcon()).rejects.toMatchObject({
      message: 'that image has changed since it was uploaded — upload it again',
    });
  });
});

describe('listing media — the re-check fails CLOSED only on disagreement', () => {
  it('allows a row that carries no recorded token (written before this existed)', async () => {
    const original = await flatPng(512, 512, 8);
    putObject(KEY, original);
    // A legacy row: measured columns, but only the byte size in metadata.
    mockRead.image.findUnique.mockResolvedValue(
      rowWith({ size: original.byteLength }, { width: 512, height: 512 })
    );
    // …and the object behind it has since been replaced. With nothing recorded
    // there is no evidence of that, and an absence must not become a rejection.
    putObject(KEY, await flatPng(160, 120, 200));

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });
  });

  it('allows the attach when the store cannot be consulted at all', async () => {
    putObject(KEY, await flatPng(512, 512, 8));
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 512 }));

    storeOutage = Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } });

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });
  });

  it('allows the attach when the store reports the object missing', async () => {
    putObject(KEY, await flatPng(512, 512, 8));
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 512 }));

    store.delete(KEY);

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });
  });

  it('allows the attach when the store returns no token for the object', async () => {
    putObject(KEY, await flatPng(512, 512, 8));
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 512 }));

    // Present, but the backend answered without one — nothing to compare.
    putObject(KEY, await flatPng(160, 120, 200), { etag: null });

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });
  });

  it('does NOT spend a head request on a row that carries no token', async () => {
    putObject(KEY, await flatPng(512, 512, 8));
    mockRead.image.findUnique.mockResolvedValue(rowWith({ size: 1 }, { width: 512, height: 512 }));
    mockS3Send.mockClear();

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

describe('listing media — the pre-existing attach rules are unchanged', () => {
  /**
   * NEGATIVE CONTROL for the guard's placement. It runs before the column
   * validation, so a bad-geometry image must still be rejected for ITS OWN reason
   * — not silently swallowed by, or shadowed into, the integrity message.
   */
  it('still rejects a non-square icon, with the geometry message', async () => {
    const original = await flatPng(512, 200, 8);
    putObject(KEY, original);
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue(rowWith(metadata, { width: 512, height: 200 }));

    const err = await attachAsIcon().catch((e: { message: string }) => e);
    expect((err as { message: string }).message).not.toContain('changed since it was uploaded');
    expect(mockRead.appListing.update).not.toHaveBeenCalled();
  });

  it('still rejects an image the caller does not own, before any store call', async () => {
    putObject(KEY, await flatPng(512, 512, 8));
    const metadata = await persistAndCaptureMetadata();
    mockRead.image.findUnique.mockResolvedValue({
      ...rowWith(metadata, { width: 512, height: 512 }),
      userId: 99,
    });
    mockS3Send.mockClear();

    await expect(attachAsIcon()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});

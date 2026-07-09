import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * External-listing metadata AUTO-PULL service. Covers `fetchListingMeta` (page →
 * suggestions; non-https reject; SafeFetchError → friendly BAD_REQUEST; empty page
 * → {}) and `ingestListingAssetFromUrl` (SSRF-safe image fetch → sharp decode →
 * upload the bytes into the SCANNABLE image store → `createImage` through the
 * STANDARD scan pipeline; the scan-invariant that `createImage` is called WITHOUT
 * `skipIngestion`; unsupported format reject).
 *
 * 🔴 STORE-CONVERGENCE REGRESSION GUARD: the original bug uploaded the bytes to
 * Cloudflare Images (`uploadBufferToCF`) and stored the CF Images id as
 * `Image.url`. The scanner's edge URL (`getEdgeUrl` → `NEXT_PUBLIC_IMAGE_LOCATION`)
 * never resolves a CF Images id, so it 404'd at scan time and every OG-pull image
 * went terminally `ImageIngestionStatus.NotFound`. The fix routes the bytes
 * through `uploadImageBufferToStore` — the SAME B2 image bucket + storage-resolver
 * registration the working browser-direct upload path uses — and stores its UUID
 * key. These tests assert that convergence (and would FAIL on the old CF path).
 *
 * All I/O deps (safeFetch, sharp, the store upload, createImage) are mocked.
 */

// A real SafeFetchError class shared with the mocked module so `instanceof` holds
// in the service under test.
const { mockSafeFetch, SafeFetchError } = vi.hoisted(() => {
  class SafeFetchError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'SafeFetchError';
      this.code = code;
    }
  }
  return { mockSafeFetch: vi.fn(), SafeFetchError };
});
vi.mock('~/server/utils/safe-fetch', () => ({ safeFetch: mockSafeFetch, SafeFetchError }));

const { mockMetadata, mockSharp } = vi.hoisted(() => {
  const mockMetadata = vi.fn();
  const mockSharp = vi.fn(() => ({ metadata: mockMetadata }));
  return { mockMetadata, mockSharp };
});
vi.mock('sharp', () => ({ default: mockSharp }));

const { mockUploadImageBufferToStore } = vi.hoisted(() => ({
  mockUploadImageBufferToStore: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({
  uploadImageBufferToStore: mockUploadImageBufferToStore,
}));

const { mockCreateImage } = vi.hoisted(() => ({ mockCreateImage: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ createImage: mockCreateImage }));

import {
  fetchListingMeta,
  ingestListingAssetFromUrl,
} from '~/server/services/blocks/listing-meta.service';

beforeEach(() => {
  mockSafeFetch.mockReset();
  mockMetadata.mockReset();
  mockSharp.mockClear();
  mockUploadImageBufferToStore.mockReset();
  mockCreateImage.mockReset();
});

describe('fetchListingMeta', () => {
  it('returns parsed suggestions from the fetched page', async () => {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://vendor.example.com/app',
      contentType: 'text/html',
      bytes: Buffer.from(
        '<meta property="og:title" content="Cool App">' +
          '<meta property="og:description" content="Neat">' +
          '<meta property="og:image" content="https://cdn.example.com/og.png">'
      ),
    });
    const r = await fetchListingMeta({ url: 'https://vendor.example.com/app' });
    expect(r).toEqual({
      name: 'Cool App',
      tagline: 'Neat',
      coverImageUrl: 'https://cdn.example.com/og.png',
    });
  });

  it('rejects a non-https URL BEFORE any fetch', async () => {
    await expect(fetchListingMeta({ url: 'http://vendor.example.com' })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it('maps a SafeFetchError to a friendly BAD_REQUEST (no leak)', async () => {
    mockSafeFetch.mockRejectedValue(new SafeFetchError('blocked_host', 'host resolves to private'));
    await expect(
      fetchListingMeta({ url: 'https://vendor.example.com' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringMatching(/preview info/i) });
  });

  it('returns {} when the page has no usable tags (graceful)', async () => {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://vendor.example.com',
      contentType: 'text/html',
      bytes: Buffer.from('<html><body>nothing</body></html>'),
    });
    expect(await fetchListingMeta({ url: 'https://vendor.example.com' })).toEqual({});
  });
});

describe('ingestListingAssetFromUrl', () => {
  const imageBytes = Buffer.from('fake-image-bytes');

  function primeHappyPath() {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://cdn.example.com/og.png',
      contentType: 'image/jpeg',
      bytes: imageBytes,
    });
    mockMetadata.mockResolvedValue({ width: 640, height: 480, format: 'jpeg' });
    mockUploadImageBufferToStore.mockResolvedValue({ key: 'store-uuid-key', backend: 'backblaze' });
    mockCreateImage.mockResolvedValue({ id: 999 });
  }

  it('safe-fetches → decodes → uploads to the scannable store → createImage (default scan pipeline) → imageId', async () => {
    primeHappyPath();
    const res = await ingestListingAssetFromUrl({
      input: { url: 'https://cdn.example.com/og.png', kind: 'cover' },
      userId: 7,
    });
    expect(res).toEqual({ imageId: 999 });

    // STORE CONVERGENCE (regression guard): the bytes go to the SAME scannable
    // image store the working manual-upload path uses — NOT Cloudflare Images.
    // The bytes uploaded are the ones safeFetch returned (never a re-fetch), and
    // the decoded mime is passed as the object Content-Type.
    expect(mockUploadImageBufferToStore).toHaveBeenCalledTimes(1);
    expect(mockUploadImageBufferToStore).toHaveBeenCalledWith(
      imageBytes,
      expect.objectContaining({ contentType: 'image/jpeg' })
    );

    // SCAN INVARIANT: createImage is called with the STORE's UUID key as
    // `Image.url` (what the edge URL + scanner resolve) and default ingestion —
    // NO skipIngestion — so the image flows through the standard scan-gate and can
    // reach `Scanned`. (On the old CF path this url was a CF Images id → NotFound.)
    expect(mockCreateImage).toHaveBeenCalledTimes(1);
    const arg = mockCreateImage.mock.calls[0][0];
    expect(arg).toMatchObject({
      url: 'store-uuid-key',
      type: 'image',
      width: 640,
      height: 480,
      mimeType: 'image/jpeg',
      userId: 7,
      metadata: {
        size: imageBytes.byteLength,
        source: 'app-listing-og-pull',
        appListingAssetKind: 'cover',
      },
    });
    expect(arg.skipIngestion).toBeUndefined();
  });

  it('maps a SafeFetchError to a friendly BAD_REQUEST', async () => {
    mockSafeFetch.mockRejectedValue(new SafeFetchError('too_large', 'oversize'));
    await expect(
      ingestListingAssetFromUrl({ input: { url: 'https://cdn.example.com/x', kind: 'icon' }, userId: 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects an unsupported decoded format (e.g. gif) without ingesting', async () => {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://cdn.example.com/x.gif',
      contentType: 'image/gif',
      bytes: imageBytes,
    });
    mockMetadata.mockResolvedValue({ width: 100, height: 100, format: 'gif' });
    await expect(
      ingestListingAssetFromUrl({ input: { url: 'https://cdn.example.com/x.gif', kind: 'icon' }, userId: 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects an image whose decoded dimensions exceed the max-side cap (decompression-bomb guard)', async () => {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://cdn.example.com/huge.png',
      contentType: 'image/png',
      bytes: imageBytes,
    });
    // Tiny file, but decodes to an absurd 100000×100000 canvas — must be rejected
    // BEFORE the CF upload + createImage scan pipeline.
    mockMetadata.mockResolvedValue({ width: 100_000, height: 100_000, format: 'png' });
    await expect(
      ingestListingAssetFromUrl({
        input: { url: 'https://cdn.example.com/huge.png', kind: 'cover' },
        userId: 1,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockUploadImageBufferToStore).not.toHaveBeenCalled();
    expect(mockCreateImage).not.toHaveBeenCalled();
  });

  it('rejects when the bytes cannot be decoded as an image', async () => {
    mockSafeFetch.mockResolvedValue({
      finalUrl: 'https://cdn.example.com/x',
      contentType: 'image/png',
      bytes: imageBytes,
    });
    mockMetadata.mockRejectedValue(new Error('unsupported image format'));
    await expect(
      ingestListingAssetFromUrl({ input: { url: 'https://cdn.example.com/x', kind: 'icon' }, userId: 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockCreateImage).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UNMOCKED sharp integration test for the inline-icon rasterizer (the data-URI icon
 * accept path). Unlike `listing-meta.service.test.ts` — which MOCKS sharp to unit-test
 * the control flow — this runs REAL sharp / librsvg so the security invariants are
 * CI-guarded against a sharp/libvips/librsvg bump:
 *
 *   (a) raw SVG is NEVER stored/served — the bytes that reach the store are always PNG;
 *   (b) an external SVG resource ref (`file://` / `http://`) is NOT fetched/embedded;
 *   (c) an over-`limitInputPixels` SVG (huge viewBox) is REJECTED cleanly (BAD_REQUEST,
 *       nothing stored) via the EXPLICIT input-pixel cap — not a 500, not an OOM.
 *
 * Only the downstream store + DB are mocked; sharp/librsvg run for real. Fast + hermetic
 * (no network, tiny inline SVGs).
 */

vi.mock('~/utils/s3-utils', () => ({ uploadImageBufferToStore: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ createImage: vi.fn() }));

import { uploadImageBufferToStore } from '~/utils/s3-utils';
import { createImage } from '~/server/services/image.service';
import { ingestListingAssetFromDataUri } from '~/server/services/blocks/listing-meta.service';

const upload = vi.mocked(uploadImageBufferToStore);
const create = vi.mocked(createImage);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function svgDataUri(inner: string): string {
  return 'data:image/svg+xml,' + encodeURIComponent(inner);
}

beforeEach(() => {
  upload.mockReset();
  create.mockReset();
  upload.mockResolvedValue({ key: 'store-key', backend: 'backblaze' } as never);
  create.mockResolvedValue({ id: 42 } as never);
});

describe('ingestListingAssetFromDataUri — REAL sharp rasterization (integration)', () => {
  it('(a) rasterizes a valid data:image/svg+xml to PNG and NEVER stores raw SVG bytes', async () => {
    const svg = svgDataUri(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
    );
    const res = await ingestListingAssetFromDataUri({ input: { dataUri: svg, kind: 'icon' }, userId: 1 });
    expect(res).toEqual({ imageId: 42 });

    expect(upload).toHaveBeenCalledTimes(1);
    const stored = upload.mock.calls[0][0] as Buffer;
    // Real PNG magic bytes; NO SVG markup anywhere in the stored bytes.
    expect(stored.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(stored.includes(Buffer.from('<svg'))).toBe(false);
    expect(stored.includes(Buffer.from('rect'))).toBe(false);
    expect(upload.mock.calls[0][1]).toMatchObject({ contentType: 'image/png' });
    // Standard scan pipeline: the PNG store key + png mime, no bypass.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'store-key', mimeType: 'image/png' })
    );
  });

  it('(b) does NOT fetch/embed an external SVG resource ref (file:// / http://)', async () => {
    const svg = svgDataUri(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32">' +
        '<image href="file:///etc/passwd" xlink:href="file:///etc/passwd" width="32" height="32"/>' +
        '<image href="http://169.254.169.254/latest/meta-data/" width="32" height="32"/>' +
        '</svg>'
    );
    let stored: Buffer | undefined;
    try {
      await ingestListingAssetFromDataUri({ input: { dataUri: svg, kind: 'icon' }, userId: 1 });
      stored = upload.mock.calls[0]?.[0] as Buffer | undefined;
    } catch (e) {
      // Rejecting cleanly is equally acceptable — either outcome means NO leak/fetch.
      expect((e as { code?: string }).code).toBe('BAD_REQUEST');
    }
    if (stored) {
      // If it rasterized, the external resource's contents are NOT embedded, and it's PNG.
      expect(stored.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(stored.includes(Buffer.from('root:'))).toBe(false);
      expect(stored.includes(Buffer.from('ami-'))).toBe(false);
    }
  });

  it('(c) REJECTS an over-limitInputPixels SVG (huge viewBox) with BAD_REQUEST — nothing stored', async () => {
    // 15000×15000 ≈ 225MP > the 16MP input cap. librsvg would render this at ~900MB at
    // intrinsic size; the explicit limitInputPixels rejects it at decode instead.
    const svg = svgDataUri(
      '<svg xmlns="http://www.w3.org/2000/svg" width="15000" height="15000"><rect width="15000" height="15000" fill="blue"/></svg>'
    );
    await expect(
      ingestListingAssetFromDataUri({ input: { dataUri: svg, kind: 'icon' }, userId: 1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(upload).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

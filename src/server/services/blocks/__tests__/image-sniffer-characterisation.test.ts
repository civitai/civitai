import { describe, expect, it, vi } from 'vitest';

// block-image-upload.service statically imports these; stub them so the module graph never
// touches a real cf-images env / S3 / image.service (same mocks as block-image-upload.service.test).
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (u: string) => `edge:${u}` }));
vi.mock('~/utils/s3-utils', () => ({ uploadImageBufferToStore: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ createImage: vi.fn() }));

import { sniffSaveBytesImage } from '~/components/AppBlocks/saveImageDownload';
import { sniffSupportedImage } from '~/server/services/blocks/block-image-upload.service';
import { detectImageType } from '~/server/services/blocks/publish-request.service';
import { SCREENSHOT_EXTENSIONS } from '~/server/schema/blocks/publish-request.schema';

/**
 * Characterisation of the three magic-byte sniffers that share `~/shared/utils/image-magic-bytes`:
 *   - `sniffSaveBytesImage`  (client, SAVE_IMAGE bytes)      — PNG(8-byte) / WebP / JPEG, no GIF
 *   - `sniffSupportedImage`  (block image upload)            — JPEG / PNG(4-byte) / GIF / WebP, ≥12 bytes
 *   - `detectImageType`      (bundle screenshots, per claim) — PNG(8-byte) / WebP / JPEG, claim must match
 *
 * EXPECTED was recorded by running this table against the three ORIGINAL hand-written
 * implementations, before they were consolidated. Each caller states its own format set and
 * signature rules, so the cells deliberately differ between columns (e.g. a 4-byte PNG prefix is a
 * PNG to the upload sniffer only; a 3-byte JPEG is too short for it). Any cell that changes is a
 * behaviour change in one of the three callers, not a refactor.
 */

const pad = (n: number, fill = 0x42) => new Array<number>(n).fill(fill);
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FIXTURES: Record<string, number[]> = {
  png: [...PNG_SIG, ...pad(8)],
  'png-8-bytes-only': PNG_SIG,
  'png-4-byte-prefix-wrong-tail': [0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00, ...pad(8)],
  'png-truncated-4': PNG_SIG.slice(0, 4),
  'png-7-of-8': [...PNG_SIG.slice(0, 7), 0x00, ...pad(8)],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...pad(14)],
  'jpeg-3-bytes-only': [0xff, 0xd8, 0xff],
  'jpeg-near-miss': [0xff, 0xd8, 0x00, 0xe0, ...pad(12)],
  webp: [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...pad(8)],
  'webp-12-bytes-only': [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP')],
  'webp-truncated-11': [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEB')],
  'riff-wave': [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE'), ...pad(8)],
  'webp-fourcc-without-riff': [...ascii('RIFX'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...pad(8)],
  // "RIFF" / "WEBP" with every byte's high bit set (0x52 → 0xd2 …).
  'webp-high-bit-riff': [0xd2, 0xc9, 0xc6, 0xc6, 0x24, 0, 0, 0, ...ascii('WEBP'), ...pad(8)],
  'webp-high-bit-fourcc': [...ascii('RIFF'), 0x24, 0, 0, 0, 0xd7, 0xc5, 0xc2, 0xd0, ...pad(8)],
  gif87a: [...ascii('GIF87a'), 0x01, 0x00, 0x01, 0x00, ...pad(6, 0)],
  gif89a: [...ascii('GIF89a'), 0x01, 0x00, 0x01, 0x00, ...pad(6, 0)],
  'gif-6-bytes-only': ascii('GIF89a'),
  random: [0x3a, 0x91, 0x07, 0xee, 0x5c, 0x12, 0xb4, 0x60, 0xd9, 0x2f, 0x81, 0x44, 0x9d, 0x70],
  html: ascii('<html><body>not an image</body></html>'),
  empty: [],
};

type Row = {
  saveBytes: string | null;
  upload: string | null;
  detect: Record<string, string | null>;
};

function characterise(): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const [name, bytes] of Object.entries(FIXTURES)) {
    out[name] = {
      saveBytes: sniffSaveBytesImage(new Uint8Array(bytes)),
      upload: sniffSupportedImage(Buffer.from(bytes)),
      detect: Object.fromEntries(
        SCREENSHOT_EXTENSIONS.map((ext) => [ext, detectImageType(Buffer.from(bytes), ext)])
      ),
    };
  }
  return out;
}

const NONE = { png: null, webp: null, jpg: null, jpeg: null };
const row = (
  saveBytes: string | null,
  upload: string | null,
  detect: Partial<Record<string, string>> = {}
): Row => ({ saveBytes, upload, detect: { ...NONE, ...detect } });

// Recorded from the ORIGINAL implementations (see the docblock).
const EXPECTED: Record<string, Row> = {
  png: row('image/png', 'image/png', { png: 'png' }),
  'png-8-bytes-only': row('image/png', null, { png: 'png' }),
  'png-4-byte-prefix-wrong-tail': row(null, 'image/png'),
  'png-truncated-4': row(null, null),
  'png-7-of-8': row(null, 'image/png'),
  jpeg: row('image/jpeg', 'image/jpeg', { jpg: 'jpg', jpeg: 'jpg' }),
  'jpeg-3-bytes-only': row('image/jpeg', null, { jpg: 'jpg', jpeg: 'jpg' }),
  'jpeg-near-miss': row(null, null),
  webp: row('image/webp', 'image/webp', { webp: 'webp' }),
  'webp-12-bytes-only': row('image/webp', 'image/webp', { webp: 'webp' }),
  'webp-truncated-11': row(null, null),
  'riff-wave': row(null, null),
  'webp-fourcc-without-riff': row(null, null),
  // detectImageType compared these with Buffer#toString('ascii'), which clears each byte's high
  // bit, so it takes them as WebP. Preserved, not endorsed: see `webpFourCcIgnoresHighBit`.
  'webp-high-bit-riff': row(null, null, { webp: 'webp' }),
  'webp-high-bit-fourcc': row(null, null, { webp: 'webp' }),
  gif87a: row(null, 'image/gif'),
  gif89a: row(null, 'image/gif'),
  'gif-6-bytes-only': row(null, null),
  random: row(null, null),
  html: row(null, null),
  empty: row(null, null),
};

describe('image magic-byte sniffers — characterisation across all three callers', () => {
  // One case per caller, so a red names WHICH caller changed.
  const column = <K extends keyof Row>(table: Record<string, Row>, k: K) =>
    Object.fromEntries(Object.entries(table).map(([name, r]) => [name, r[k]]));

  it('sniffSaveBytesImage (client SAVE_IMAGE bytes): every fixture matches the recorded result', () => {
    expect(column(characterise(), 'saveBytes')).toEqual(column(EXPECTED, 'saveBytes'));
  });

  it('sniffSupportedImage (block image upload): every fixture matches the recorded result', () => {
    expect(column(characterise(), 'upload')).toEqual(column(EXPECTED, 'upload'));
  });

  it('detectImageType (bundle screenshots), per claimed extension: every fixture matches the recorded result', () => {
    expect(column(characterise(), 'detect')).toEqual(column(EXPECTED, 'detect'));
  });

  it('the fixture table covers every row the expectation names (no silent drop)', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(FIXTURES)).toHaveLength(21);
  });
});

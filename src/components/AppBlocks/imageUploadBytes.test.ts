import { describe, expect, it } from 'vitest';
import {
  imageUploadResultFromScan,
  processUploadBytes,
  resolveImageUploadBytes,
  UPLOAD_BYTES_BUSY_ERROR,
  UPLOAD_BYTES_MAX_BYTES,
  UPLOAD_BYTES_MAX_BYTES_PER_WINDOW,
  UPLOAD_BYTES_MAX_PER_WINDOW,
  UPLOAD_BYTES_TOO_LARGE_ERROR,
  UPLOAD_BYTES_TYPE_NOT_ALLOWED_ERROR,
  UPLOAD_BYTES_WINDOW_MS,
} from './imageUploadBytes';
import type { SaveBytesWindowEntry } from './saveImageDownload';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];

/** `size` bytes whose head is `head` — the sniffer only reads the head. */
function buf(head: number[], size = head.length): ArrayBuffer {
  const u8 = new Uint8Array(size);
  u8.set(head);
  return u8.buffer;
}

const T0 = 1_000_000;

describe('resolveImageUploadBytes', () => {
  it('is `none` when there is no bytes field, so the picker paths run unchanged', () => {
    expect(resolveImageUploadBytes({ requestId: 'r' })).toEqual({ kind: 'none' });
    expect(resolveImageUploadBytes({ requestId: 'r', bytes: null })).toEqual({ kind: 'none' });
    expect(resolveImageUploadBytes(undefined)).toEqual({ kind: 'none' });
  });

  it('takes an ArrayBuffer and a string filename', () => {
    const bytes = buf(PNG);
    expect(resolveImageUploadBytes({ requestId: 'r', bytes, filename: 'fixed.png' })).toEqual({
      kind: 'bytes',
      bytes,
      filename: 'fixed.png',
    });
    expect(resolveImageUploadBytes({ requestId: 'r', bytes, filename: 5 })).toEqual({
      kind: 'bytes',
      bytes,
      filename: undefined,
    });
  });

  it.each([
    ['a Uint8Array view (its window into .buffer is not the file)', new Uint8Array(PNG)],
    ['an empty buffer', new ArrayBuffer(0)],
    ['a string', 'iVBORw0KGgo='],
  ])('refuses %s as invalid', (_label, bytes) => {
    expect(resolveImageUploadBytes({ requestId: 'r', bytes })).toEqual({ kind: 'invalid' });
  });

  it('refuses bytes with purpose generationSource (that purpose creates no Image row)', () => {
    expect(
      resolveImageUploadBytes({ requestId: 'r', bytes: buf(PNG), purpose: 'generationSource' })
    ).toEqual({ kind: 'invalid' });
    expect(
      resolveImageUploadBytes({ requestId: 'r', bytes: buf(PNG), purpose: 'display' }).kind
    ).toBe('bytes');
  });
});

describe('processUploadBytes', () => {
  it('pins the limits: 40 MiB per file (the server cap), 3 uploads and 80 MiB per 60 s', () => {
    expect(UPLOAD_BYTES_MAX_BYTES).toBe(40 * 1024 * 1024);
    expect(UPLOAD_BYTES_MAX_PER_WINDOW).toBe(3);
    expect(UPLOAD_BYTES_MAX_BYTES_PER_WINDOW).toBe(80 * 1024 * 1024);
    expect(UPLOAD_BYTES_WINDOW_MS).toBe(60_000);
  });

  it.each([
    ['PNG', PNG, 'image/png', 'fixed.png'],
    ['JPEG', JPEG, 'image/jpeg', 'fixed.jpg'],
    ['WebP', WEBP, 'image/webp', 'fixed.webp'],
  ])(
    'accepts %s by its bytes, under its own extension whatever the name says',
    (_l, head, type, name) => {
      const { result } = processUploadBytes({ bytes: buf(head), filename: 'fixed.txt' }, [], T0);
      expect(result).toEqual({ ok: true, contentType: type, filename: name });
    }
  );

  it.each([
    ['GIF', GIF],
    ['plain text', [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x21]],
    ['a PNG with only the 4-byte prefix', [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]],
  ])('refuses %s and does not record it', (_l, head) => {
    const out = processUploadBytes({ bytes: buf(head), filename: 'x.png' }, [], T0);
    expect(out.result).toEqual({ ok: false, error: UPLOAD_BYTES_TYPE_NOT_ALLOWED_ERROR });
    expect(out.recent).toEqual([]);
  });

  it('an over-cap file is too-large even when the window is also full (cap first)', () => {
    const full: SaveBytesWindowEntry[] = [1, 2, 3].map((i) => ({ at: T0 + i, size: 10 }));
    const out = processUploadBytes({ bytes: buf(PNG, UPLOAD_BYTES_MAX_BYTES + 1) }, full, T0 + 10);
    expect(out.result).toEqual({ ok: false, error: UPLOAD_BYTES_TOO_LARGE_ERROR });
  });

  it('a file exactly at the cap is accepted (the boundary is inclusive)', () => {
    const out = processUploadBytes({ bytes: buf(PNG, UPLOAD_BYTES_MAX_BYTES) }, [], T0);
    expect(out.result.ok).toBe(true);
  });

  it('the 4th upload inside the window is busy, and the window frees after it', () => {
    let recent: SaveBytesWindowEntry[] = [];
    const verdicts: string[] = [];
    for (let i = 0; i < UPLOAD_BYTES_MAX_PER_WINDOW + 1; i++) {
      const out = processUploadBytes({ bytes: buf(PNG, 100 + i) }, recent, T0 + i);
      recent = out.recent;
      verdicts.push(out.result.ok ? 'ok' : out.result.error);
    }
    expect(verdicts).toEqual(['ok', 'ok', 'ok', UPLOAD_BYTES_BUSY_ERROR]);
    expect(recent.map((e) => e.size)).toEqual([100, 101, 102]);

    // Still inside the window of the FIRST entry (age = window - 1): busy.
    expect(
      processUploadBytes({ bytes: buf(PNG) }, recent, T0 + UPLOAD_BYTES_WINDOW_MS - 1).result
    ).toEqual({ ok: false, error: UPLOAD_BYTES_BUSY_ERROR });
    // Once the first entry has aged out, one slot reopens.
    expect(
      processUploadBytes({ bytes: buf(PNG) }, recent, T0 + UPLOAD_BYTES_WINDOW_MS).result.ok
    ).toBe(true);
  });

  it('the byte budget refuses busy before the count budget does', () => {
    const big = UPLOAD_BYTES_MAX_BYTES_PER_WINDOW / 2 - 1000;
    const recent: SaveBytesWindowEntry[] = [
      { at: T0, size: big },
      { at: T0 + 1, size: big },
    ];
    // 2 of 3 slots used, 2000 bytes of budget left: 2000 fits, 2001 does not.
    expect(processUploadBytes({ bytes: buf(PNG, 2000) }, recent, T0 + 2).result.ok).toBe(true);
    expect(processUploadBytes({ bytes: buf(PNG, 2001) }, recent, T0 + 2).result).toEqual({
      ok: false,
      error: UPLOAD_BYTES_BUSY_ERROR,
    });
  });

  it('bounds the name to Image.name’s 255 characters, keeping the extension', () => {
    const { result } = processUploadBytes(
      { bytes: buf(PNG), filename: `${'a'.repeat(400)}.png` },
      [],
      T0
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.filename).toHaveLength(255);
    expect(result.filename.endsWith('.png')).toBe(true);
  });

  it('names a nameless upload `download.<ext>`', () => {
    const { result } = processUploadBytes({ bytes: buf(JPEG) }, [], T0);
    expect(result).toMatchObject({ ok: true, filename: 'download.jpg' });
  });
});

describe('imageUploadResultFromScan (blocking reply)', () => {
  const image = {
    imageId: 77,
    nsfwLevel: 1,
    contentRating: 'pg' as never,
    url: 'https://image.civitai.com/x/77/width=1200/original.jpeg',
  };

  it('a scanned verdict is the moderated projection a picked display upload returns', () => {
    expect(imageUploadResultFromScan('rq', { status: 'scanned', image })).toEqual({
      requestId: 'rq',
      selected: image,
    });
  });

  it.each([
    [{ status: 'blocked' as const, reason: 'that image was flagged' }, 'that image was flagged'],
    [{ status: 'blocked' as const }, 'that image could not be used'],
    [{ status: 'error' as const, message: 'Image scan timed out' }, 'Image scan timed out'],
    [{ status: 'error' as const }, 'image scan failed — please try again'],
  ])('%o replies an error string, never the bare cancelled shape', (scan, error) => {
    expect(imageUploadResultFromScan('rq', scan)).toEqual({ requestId: 'rq', error });
  });
});

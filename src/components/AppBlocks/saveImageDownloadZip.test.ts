import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { SAVE_ZIP_INFLATE_ERROR, SAVE_ZIP_MAX_BYTES } from '@civitai/app-sdk/save-zip';
import {
  classifySaveBytesContent,
  prepareSaveBytes,
  processSaveBytes,
  SAVE_BYTES_MAX_BYTES,
  SAVE_BYTES_MAX_PER_WINDOW,
  SAVE_BYTES_ZIP_MAX_BYTES,
  SAVE_BYTES_ZIP_MAX_BYTES_PER_WINDOW,
  verifySaveBytesContent,
} from './saveImageDownload';

// The HOST WIRING of a zip save: classification order, naming, the zip caps and window, and the
// inflate step through `verifySaveBytesContent`. The validator itself (`@civitai/app-sdk/save-zip`)
// and its rules are tested where it lives, in the app-sdk package; nothing here re-tests them.

const MB = 1024 * 1024;
const enc = new TextEncoder();
// A real PNG signature + IHDR start, so a sniffer that only checks length can't pass.
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49];

const jszip = async (
  files: Record<string, string | Uint8Array>,
  compression: 'STORE' | 'DEFLATE' = 'STORE'
) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const u8 = await zip.generateAsync({ type: 'uint8array', compression });
  return u8.slice().buffer;
};

const DATASET = {
  'images/001.png': new Uint8Array([...PNG_HEAD, 1, 2, 3]),
  'images/001.txt': 'a cat, sitting, sunlight',
  'meta.json': '{"trigger":"my-dataset"}',
};

/** A valid single-entry STORED zip of exactly `total` bytes, written in place (no second copy). */
function storedZipOfSize(total: number, name = 'big.png'): ArrayBuffer {
  const n = enc.encode(name);
  const dataLen = total - (30 + n.length) - (46 + n.length) - 22;
  const u8 = new Uint8Array(total);
  const v = new DataView(u8.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint32(18, dataLen, true);
  v.setUint32(22, dataLen, true);
  v.setUint16(26, n.length, true);
  u8.set(n, 30);
  const cd = 30 + n.length + dataLen;
  v.setUint32(cd, 0x02014b50, true);
  v.setUint16(cd + 4, 20, true);
  v.setUint16(cd + 6, 20, true);
  v.setUint32(cd + 20, dataLen, true);
  v.setUint32(cd + 24, dataLen, true);
  v.setUint16(cd + 28, n.length, true);
  u8.set(n, cd + 46);
  const eocd = cd + 46 + n.length;
  v.setUint32(eocd, 0x06054b50, true);
  v.setUint16(eocd + 8, 1, true);
  v.setUint16(eocd + 10, 1, true);
  v.setUint32(eocd + 12, 46 + n.length, true);
  v.setUint32(eocd + 16, cd, true);
  return u8.buffer;
}

/** Rewrite a single-entry zip's declared uncompressed size in BOTH headers (a consistent lie). */
function lieAboutSize(zip: ArrayBuffer, size: number): ArrayBuffer {
  const copy = zip.slice(0);
  const v = new DataView(copy);
  const eocd = copy.byteLength - 22;
  const cd = v.getUint32(eocd + 16, true);
  v.setUint32(22, size, true);
  v.setUint32(cd + 24, size, true);
  return copy;
}

describe('zip classification on the save path', () => {
  it('classifies a valid zip by CONTENT and always names it .zip', async () => {
    const zip = await jszip(DATASET);
    expect(classifySaveBytesContent(zip, 'whatever.png')).toMatchObject({
      ok: true,
      type: 'application/zip',
    });
    for (const [filename, saved] of [
      ['dataset.zip', 'dataset.zip'],
      ['dataset', 'dataset.zip'],
      ['dataset.png', 'dataset.zip'],
      ['../../evil.exe', 'evil.zip'],
      [undefined, 'download.zip'],
    ] as const) {
      expect(prepareSaveBytes({ bytes: zip, filename })).toMatchObject({
        ok: true,
        type: 'application/zip',
        filename: saved,
      });
    }
  });

  it('a non-zip named .zip is classified by content: text saves as .txt, binary is refused', () => {
    const text = enc.encode('not a zip at all').buffer as ArrayBuffer;
    expect(prepareSaveBytes({ bytes: text, filename: 'dataset.zip' })).toEqual({
      ok: true,
      type: 'text/plain',
      filename: 'dataset.txt',
    });
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xfe]).buffer;
    expect(prepareSaveBytes({ bytes: binary, filename: 'dataset.zip' })).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });

  it('a PNG with a zip APPENDED is a PNG (image sniff wins), saved as .png — decided, not accidental', async () => {
    const zip = new Uint8Array(await jszip({ 'payload.exe': 'MZ' }));
    const poly = new Uint8Array(PNG_HEAD.length + zip.length);
    poly.set(PNG_HEAD);
    poly.set(zip, PNG_HEAD.length);
    expect(classifySaveBytesContent(poly.buffer, 'x.zip')).toEqual({ ok: true, type: 'image/png' });
    expect(prepareSaveBytes({ bytes: poly.buffer, filename: 'x.zip' })).toEqual({
      ok: true,
      type: 'image/png',
      filename: 'x.png',
    });
  });

  it('a zip behind any non-image prefix (a self-extractor) is refused, never unwrapped', async () => {
    const zip = new Uint8Array(await jszip({ 'a.txt': 'x' }));
    const sfx = new Uint8Array(2 + zip.length);
    sfx.set([0x4d, 0x5a]); // MZ
    sfx.set(zip, 2);
    expect(prepareSaveBytes({ bytes: sfx.buffer, filename: 'a.zip' })).toEqual({
      ok: false,
      error: 'file type is not allowed',
    });
  });

  it('a refused zip reports the zip reason, not a generic type error, and never falls back to text', async () => {
    const zip = await jszip({ 'evil.html': '<script>' });
    expect(prepareSaveBytes({ bytes: zip, filename: 'x.zip' })).toEqual({
      ok: false,
      error: 'zip entry type is not allowed: html',
    });
  });
});

describe('verifySaveBytesContent — the inflate step before the download', () => {
  it('passes a valid deflated zip, and refuses one whose entry inflates past its declared size', async () => {
    const dataset = await jszip(DATASET, 'DEFLATE');
    const ok = prepareSaveBytes({ bytes: dataset, filename: 'd.zip' });
    expect(ok).toMatchObject({ ok: true, type: 'application/zip' });
    if (!ok.ok) return;
    expect(ok.type === 'application/zip' && ok.deflated.length).toBe(3);
    expect(await verifySaveBytesContent(dataset, ok)).toBeNull();

    // 5 MB of zeros deflates to a few KB. Declare a size that keeps the ratio under 100x so only the inflate step can catch it.
    const real = await jszip({ 'zeros.txt': new Uint8Array(5 * MB + 3) }, 'DEFLATE');
    const lie = lieAboutSize(real, 9_999);
    const prepared = prepareSaveBytes({ bytes: lie, filename: 'd.zip' });
    expect(prepared).toMatchObject({ ok: true, type: 'application/zip' });
    if (!prepared.ok) return;
    expect(await verifySaveBytesContent(lie, prepared)).toBe(SAVE_ZIP_INFLATE_ERROR);
  });

  it('is a no-op for non-zip types', async () => {
    expect(
      await verifySaveBytesContent(new ArrayBuffer(4), {
        ok: true,
        type: 'text/plain',
        filename: 'a.txt',
      })
    ).toBeNull();
  });
});

describe('zip size caps on the path the handler calls (processSaveBytes)', () => {
  const T0 = 9_000_000;

  it('pins the zip caps: 256 MB per file and per window, other types unchanged', () => {
    expect(SAVE_ZIP_MAX_BYTES).toBe(256 * MB);
    expect(SAVE_BYTES_ZIP_MAX_BYTES).toBe(256 * MB);
    expect(SAVE_BYTES_ZIP_MAX_BYTES_PER_WINDOW).toBe(256 * MB);
    expect(SAVE_BYTES_MAX_BYTES).toBe(50 * MB);
  });

  it('a zip AT 256 MB is accepted; one byte over is too large', () => {
    const atCap = storedZipOfSize(SAVE_BYTES_ZIP_MAX_BYTES);
    const ok = processSaveBytes({ bytes: atCap, filename: 'dataset.zip' }, [], T0);
    expect(ok.result).toMatchObject({ ok: true, type: 'application/zip', filename: 'dataset.zip' });
    expect(ok.recent).toEqual([{ at: T0, size: SAVE_BYTES_ZIP_MAX_BYTES }]);

    const over = storedZipOfSize(SAVE_BYTES_ZIP_MAX_BYTES + 1);
    const refused = processSaveBytes({ bytes: over, filename: 'dataset.zip' }, [], T0 + 1);
    expect(refused.result).toEqual({ ok: false, error: 'file exceeds the maximum save size' });
    expect(refused.recent).toEqual([]);
  });

  it('the raised cap is for zips only: a 61 MB zip is accepted, 61 MB of text is too large', () => {
    const size = 61 * MB + 7;
    const zip = processSaveBytes({ bytes: storedZipOfSize(size) }, [], T0);
    expect(zip.result).toMatchObject({ ok: true, type: 'application/zip' });
    const text = processSaveBytes({ bytes: new Uint8Array(size).fill(0x61).buffer }, [], T0);
    expect(text.result).toEqual({ ok: false, error: 'file exceeds the maximum save size' });
  });

  it('the window: a 130 MB zip fits an empty window (over the 100 MB non-zip budget)…', () => {
    const big = 130 * MB + 11;
    const r = processSaveBytes({ bytes: storedZipOfSize(big) }, [], T0);
    expect(r.result).toMatchObject({ ok: true, type: 'application/zip' });
    // …a following small text save is still held to the 100 MB budget, so it is busy…
    const after = processSaveBytes(
      { bytes: enc.encode('hi').buffer as ArrayBuffer },
      r.recent,
      T0 + 1
    );
    expect(after.result).toEqual({ ok: false, error: 'busy' });
    // …and a second zip that would take the window over 256 MB is busy too.
    const second = processSaveBytes({ bytes: storedZipOfSize(126 * MB + 5) }, r.recent, T0 + 2);
    expect(second.result).toEqual({ ok: false, error: 'busy' });
    const fits = processSaveBytes({ bytes: storedZipOfSize(125 * MB + 5) }, r.recent, T0 + 3);
    expect(fits.result).toMatchObject({ ok: true, type: 'application/zip' });
  });

  it('a full window refuses a zip `busy` WITHOUT validating it (a malformed zip still says busy)', async () => {
    const full = Array.from({ length: SAVE_BYTES_MAX_PER_WINDOW }, (_, i) => ({
      at: T0 + i,
      size: 10,
    }));
    const malformed = await jszip({ 'evil.exe': 'MZ' });
    expect(processSaveBytes({ bytes: malformed }, full, T0 + 9).result).toEqual({
      ok: false,
      error: 'busy',
    });
    // Control: with room, the same bytes are refused for their content.
    expect(processSaveBytes({ bytes: malformed }, [], T0 + 9).result).toEqual({
      ok: false,
      error: 'zip entry type is not allowed: exe',
    });
  });
});

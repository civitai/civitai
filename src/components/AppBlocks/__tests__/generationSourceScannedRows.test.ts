import { describe, expect, it, vi } from 'vitest';
import {
  toGenerationSource,
  type ScannedRowsPath,
} from '~/components/AppBlocks/generationSourceScannedRows';

/**
 * The one decision the host makes after a generation-source upload lands as a consumer blob:
 * hand the blob back as today, or have the server copy it into a private scanned row.
 *
 * - The flag says OFF → the blob, byte-identical to today; the server copy is never asked for.
 * - The flag can't be read (the path query fails) → the blob. The generation gate stays the only
 *   authority, so this can never admit an unscanned source while the flag is ON; it only gets
 *   the pre-fix refusal at submit.
 * - The flag says ON → the server copy, and a failed copy is an ERROR, never a fallback to the
 *   blob (that blob is exactly what the gate refuses while ON).
 */

const BLOB = {
  url: 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=x&exp=2030-01-01T00:00:00Z',
  width: 640,
  height: 480,
};
const PERSISTED = {
  url: 'https://image.civitai.com/x/k/original=true/k.jpeg',
  width: 638,
  height: 479,
  imageId: 9001,
  ready: true,
};

function path(over: Partial<ScannedRowsPath> = {}) {
  const usesScannedRows = vi.fn<ScannedRowsPath['usesScannedRows']>(async () => true);
  const persist = vi.fn<ScannedRowsPath['persist']>(async () => PERSISTED);
  if (over.usesScannedRows) usesScannedRows.mockImplementation(over.usesScannedRows);
  if (over.persist) persist.mockImplementation(over.persist);
  return { usesScannedRows, persist };
}

describe('toGenerationSource', () => {
  it('no path (no block token): the blob, unchanged', async () => {
    await expect(toGenerationSource(BLOB, null)).resolves.toBe(BLOB);
    await expect(toGenerationSource(BLOB, undefined)).resolves.toBe(BLOB);
  });

  it('flag OFF: the blob, unchanged, and the server copy is never asked for', async () => {
    const p = path({ usesScannedRows: vi.fn(async () => false) });
    const out = await toGenerationSource(BLOB, p);
    expect(out).toBe(BLOB);
    expect(Object.keys(out!).sort()).toEqual(['height', 'url', 'width']);
    expect(p.persist).not.toHaveBeenCalled();
  });

  it('🔴 the path query FAILS: falls back to the blob, never to a copy', async () => {
    const p = path({ usesScannedRows: vi.fn(async () => Promise.reject(new Error('503'))) });
    await expect(toGenerationSource(BLOB, p)).resolves.toBe(BLOB);
    expect(p.persist).not.toHaveBeenCalled();
  });

  it('🔴 flag ON: the server copy of THIS blob, in the source shape plus imageId and ready', async () => {
    const p = path();
    await expect(toGenerationSource(BLOB, p)).resolves.toEqual(PERSISTED);
    expect(p.persist.mock.calls).toEqual([[BLOB.url]]);
  });

  it('flag ON with the scan still pending: ready false is passed through, not hidden', async () => {
    const p = path({ persist: vi.fn(async () => ({ ...PERSISTED, ready: false })) });
    await expect(toGenerationSource(BLOB, p)).resolves.toMatchObject({ ready: false });
  });

  it('🔴 flag ON and the copy FAILS: the error, never the blob', async () => {
    const refused = new Error('that image can’t be used as a generation source');
    const p = path({ persist: vi.fn(async () => Promise.reject(refused)) });
    await expect(toGenerationSource(BLOB, p)).rejects.toBe(refused);
  });

  it('🔴 a pick that is no longer current (re-picked, closed) issues no persist, and resolves null', async () => {
    let current = true;
    const p = path({
      usesScannedRows: vi.fn(async () => {
        current = false; // the viewer moved on while the path was being read
        return true;
      }),
    });
    await expect(toGenerationSource(BLOB, p, () => current)).resolves.toBeNull();
    expect(p.persist).not.toHaveBeenCalled();
  });

  it('a pick that is still current is persisted (the control for the case above)', async () => {
    const p = path();
    await expect(toGenerationSource(BLOB, p, () => true)).resolves.toEqual(PERSISTED);
    expect(p.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps the caller’s other fields (a media upload’s kind, mimeType, sizeBytes)', async () => {
    const media = { ...BLOB, kind: 'image' as const, mimeType: 'image/jpeg', sizeBytes: 1234 };
    await expect(toGenerationSource(media, path())).resolves.toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
      ...PERSISTED,
    });
  });
});

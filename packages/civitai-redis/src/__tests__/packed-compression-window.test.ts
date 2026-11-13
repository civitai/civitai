import { randomBytes } from 'crypto';
import { promisify } from 'util';
import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import {
  PACKED_BROTLI_SENTINEL,
  compressPacked,
  decompressPacked,
  packedBrotliWindowBits,
} from '../packed-compression';

const brotliCompress = promisify(zlib.brotliCompress);

/** Reads the window from the produced stream header (RFC 7932 §9.1), not from the helper. */
function readStreamWindowBits(stream: Buffer): number {
  let bitPos = 0;
  const readBits = (count: number) => {
    let value = 0;
    for (let i = 0; i < count; i++, bitPos++) {
      const bit = (stream[bitPos >> 3] >> (bitPos & 7)) & 1;
      value |= bit << i;
    }
    return value;
  };

  if (readBits(1) === 0) return 16;
  const n = readBits(3);
  if (n !== 0) return 17 + n;
  const m = readBits(3);
  if (m === 1) throw new Error('large-window brotli stream header');
  if (m !== 0) return 8 + m;
  return 17;
}

function encodeWithWindow(input: Buffer, lgwin: number) {
  return brotliCompress(input, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      [zlib.constants.BROTLI_PARAM_LGWIN]: lgwin,
    },
  });
}

// Generation-metadata-shaped text: repetitive keys and prompt words, plus enough random hex that
// the payload is not trivially compressible. `targetBytes` is approximate.
function metadataLikeBuffer(targetBytes: number): Buffer {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < targetBytes; i++) {
    const part = `{"prompt":"masterpiece, best quality, portrait ${i}","seed":${
      i * 7919
    },"hash":"${randomBytes(8).toString('hex')}","steps":30,"cfgScale":7}`;
    parts.push(part);
    length += part.length;
  }
  return Buffer.from(parts.join(','));
}

describe('packed brotli window sizing', () => {
  it('positive control: the header parser reads back the window each stream was encoded with', async () => {
    const input = metadataLikeBuffer(3_000);
    for (const lgwin of [10, 16, 18, 22]) {
      expect(readStreamWindowBits(await encodeWithWindow(input, lgwin))).toBe(lgwin);
    }
  });

  it('encodes a ~3 KB value with a window sized to it, not the 4 MiB default', async () => {
    const input = metadataLikeBuffer(3_000);
    const compressed = await compressPacked(input);
    expect(compressed[0]).toBe(PACKED_BROTLI_SENTINEL);

    const windowBits = readStreamWindowBits(compressed.subarray(1));
    expect(windowBits, `~3 KB value encoded with a ${windowBits}-bit window`).toBeLessThanOrEqual(
      12
    );
    expect(Buffer.compare(await decompressPacked(compressed), input)).toBe(0);
  });

  it('still gives a large value a large window', async () => {
    const input = metadataLikeBuffer(300_000);
    const compressed = await compressPacked(input);

    const windowBits = readStreamWindowBits(compressed.subarray(1));
    expect(
      windowBits,
      `~300 KB value encoded with a ${windowBits}-bit window`
    ).toBeGreaterThanOrEqual(19);
    expect(Buffer.compare(await decompressPacked(compressed), input)).toBe(0);
  });

  it('packedBrotliWindowBits covers the input, clamped to [10, 22]', () => {
    expect(packedBrotliWindowBits(0)).toBe(10);
    expect(packedBrotliWindowBits(900)).toBe(10);
    expect(packedBrotliWindowBits(1_023)).toBe(10);
    expect(packedBrotliWindowBits(1_024)).toBe(11);
    expect(packedBrotliWindowBits(1_500)).toBe(11);
    expect(packedBrotliWindowBits(4_095)).toBe(12);
    expect(packedBrotliWindowBits(4_096)).toBe(13);
    expect(packedBrotliWindowBits(3_000)).toBe(12);
    expect(packedBrotliWindowBits(358 * 1024)).toBe(19);
    expect(packedBrotliWindowBits(3_000_000)).toBe(22);
    expect(packedBrotliWindowBits(50_000_000)).toBe(22);
  });

  it('back-compat: a value written with the previous 22-bit window still decodes', async () => {
    const input = metadataLikeBuffer(3_000);
    const legacyStream = await encodeWithWindow(input, 22);
    expect(readStreamWindowBits(legacyStream)).toBe(22);

    const stored = Buffer.concat([Buffer.from([PACKED_BROTLI_SENTINEL]), legacyStream]);
    expect(Buffer.compare(await decompressPacked(stored), input)).toBe(0);
  });
});

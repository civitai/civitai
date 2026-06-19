import { pack, unpack } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import {
  PACKED_BROTLI_SENTINEL,
  compressPacked,
  decompressPacked,
} from '~/server/redis/packed-compression';

/**
 * Round-trip + back-compat coverage for the opt-in brotli compression of `redis.packed`
 * values (the tensor-metadata whale fix). The contract:
 *
 *  - compress (new write): pack → brotli → sentinel-prefix; decompress strips the
 *    sentinel + inflates back to the EXACT original packed bytes → unpack === original.
 *  - back-compat (legacy read): a raw-msgpack Buffer with NO sentinel must pass through
 *    decompressPacked untouched so it still unpacks correctly (the ~220k existing keys).
 */
describe('packed brotli compression', () => {
  // Mirrors the on-the-wire shape every fetchThroughCache value has: the `{ data, cachedAt }`
  // wrapper object, here wrapping a tensor-metadata-like analysis with repetitive names.
  const sampleAnalysis = {
    data: {
      format: 'SafeTensor',
      tensorCount: 3,
      totalTensorBytes: 123456,
      dtypeCounts: [{ dtype: 'F16', count: 3, bytes: 123456 }],
      largestTensor: { name: 'model.diffusion_model.blocks.0.weight', shape: [320, 320], dtype: 'F16', sizeBytes: 50000 },
      vramEstimate: null,
      tensors: Array.from({ length: 200 }, (_, i) => ({
        name: `model.diffusion_model.blocks.${i}.attn.to_q.weight`,
        shape: [320, 320],
        dtype: 'F16',
        sizeBytes: 204800,
      })),
    },
    cachedAt: 1_700_000_000_000,
  };

  it('round-trips: pack → compress → decompress → unpack equals the original', () => {
    const packed = Buffer.from(pack(sampleAnalysis));
    const compressed = compressPacked(packed);

    // Sentinel-tagged and actually smaller (highly repetitive payload).
    expect(compressed[0]).toBe(PACKED_BROTLI_SENTINEL);
    expect(compressed.length).toBeLessThan(packed.length);

    const restored = decompressPacked(compressed);
    expect(Buffer.compare(restored, packed)).toBe(0); // exact bytes
    expect(unpack(restored)).toEqual(sampleAnalysis); // exact value
  });

  it('back-compat: a legacy raw-msgpack buffer (no sentinel) decodes unchanged', () => {
    const legacy = Buffer.from(pack(sampleAnalysis)); // simulates an existing uncompressed key

    // Sanity: legacy wrapper objects start with a msgpack MAP marker, never the sentinel.
    expect(legacy[0]).not.toBe(PACKED_BROTLI_SENTINEL);
    const marker = legacy[0];
    const isFixmap = marker >= 0x80 && marker <= 0x8f;
    expect(isFixmap || marker === 0xde || marker === 0xdf).toBe(true);

    const passthrough = decompressPacked(legacy);
    expect(Buffer.compare(passthrough, legacy)).toBe(0); // untouched
    expect(unpack(passthrough)).toEqual(sampleAnalysis);
  });

  it('decompressPacked is a no-op on an empty buffer (defensive)', () => {
    const empty = Buffer.alloc(0);
    expect(decompressPacked(empty)).toBe(empty);
  });

  it('compresses a large repetitive blob substantially (the whale property)', () => {
    const big = Buffer.from(
      pack({
        data: { tensors: Array.from({ length: 2000 }, (_, i) => `transformer.h.${i}.mlp.c_fc.weight`) },
        cachedAt: 0,
      })
    );
    const compressed = compressPacked(big);
    // Not asserting the measured 64.9x (codec/version-dependent), just that it's a big win.
    expect(compressed.length).toBeLessThan(big.length / 4);
    expect(unpack(decompressPacked(compressed))).toEqual(unpack(big));
  });
});

import zlib from 'zlib';

/**
 * Opt-in brotli compression for `redis.packed` values.
 *
 * A small set of packed caches store large, highly-compressible blobs (e.g.
 * tensor-metadata: ~335 KB of repetitive tensor-name strings, measured ~65x with
 * brotli quality 6, ~0.10 ms to decompress). Compression is OPT-IN per call — most
 * packed values are tiny and would only pay overhead.
 *
 * On-disk format for a compressed value is a single SENTINEL prefix byte (0x01 = brotli)
 * followed by the brotli stream of the msgpack-packed Buffer. The reader inspects the
 * first byte to transparently handle BOTH compressed (new) and raw-msgpack (legacy)
 * values, which makes flipping compression on/off zero-downtime: the ~220k existing
 * uncompressed keys keep decoding, new writes are compressed.
 *
 * SENTINEL SAFETY: every value written through `fetchThroughCache` / `createCached*` is
 * the `{ data, cachedAt }` WRAPPER OBJECT, so a legacy (uncompressed) value's first
 * msgpack byte is always a MAP marker (0x80–0x8f fixmap / 0xde map16 / 0xdf map32) —
 * NEVER 0x01. The brotli sentinel therefore cannot collide with any legacy value on the
 * compression-enabled path. Do NOT enable compression for a caller that stores a bare
 * scalar (a positive-fixint 0x01 would be ambiguous with the sentinel).
 */
export const PACKED_BROTLI_SENTINEL = 0x01;
const PACKED_BROTLI_QUALITY = 6;

/** Brotli-compress an already-msgpack-packed Buffer and prepend the sentinel byte. */
export function compressPacked(packed: Buffer): Buffer {
  const compressed = zlib.brotliCompressSync(packed, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: PACKED_BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: packed.length,
    },
  });
  return Buffer.concat([Buffer.from([PACKED_BROTLI_SENTINEL]), compressed]);
}

/**
 * Return the raw msgpack Buffer to feed to `unpack()`, transparently handling both the
 * brotli-sentinel-prefixed (new) and raw-msgpack (legacy) on-disk formats.
 */
export function decompressPacked(value: Buffer): Buffer {
  if (value.length > 0 && value[0] === PACKED_BROTLI_SENTINEL) {
    return zlib.brotliDecompressSync(value.subarray(1));
  }
  return value;
}

import zlib from 'zlib';
import { promisify } from 'util';

/**
 * Opt-in brotli compression for `redis.packed` values.
 *
 * A small set of packed caches store large, highly-compressible blobs (e.g.
 * tensor-metadata: ~335 KB of repetitive tensor-name strings, measured ~65x with
 * brotli quality 6). Compression is OPT-IN per call — most packed values are tiny and
 * would only pay overhead.
 *
 * ASYNC codec: brotli is run via the libuv threadpool (`util.promisify(zlib.brotli*)`)
 * rather than the *Sync variants, so a worst-case large checkpoint (~tens of thousands
 * of tensors → multi-MB `tensors[]`; the safetensors header read is capped at 64 MiB,
 * measured ~36 ms compress / ~5 ms decompress) does NOT block the Node event loop. The
 * call sites in redis/client.ts set/get are already async and simply `await` these.
 *
 * On-disk format for a compressed value is a single SENTINEL prefix byte (0x01 = brotli)
 * followed by the brotli stream of the msgpack-packed Buffer.
 *
 * SENTINEL SCOPE: decompression is CONFINED to the compress-aware read path
 * (`redis.packed.get(key, { compress: true })`, used only by `fetchThroughCache` when
 * `compress: true`). The general decode path (`safeUnpack`, used by every other packed
 * read) NEVER touches this code, so the 0x01 sentinel is NOT a global invariant on all
 * packed values — it only applies on the one confined path, where every value is the
 * `{ data, cachedAt }` WRAPPER OBJECT (msgpack first byte is always a MAP marker
 * 0x80–0x8f / 0xde / 0xdf — never 0x01), making the sentinel provably collision-free.
 * Do NOT enable `compress` for a caller that stores a bare scalar (a positive-fixint
 * 0x01 would be ambiguous with the sentinel).
 */
export const PACKED_BROTLI_SENTINEL = 0x01;
const PACKED_BROTLI_QUALITY = 6;

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/** Brotli-compress an already-msgpack-packed Buffer and prepend the sentinel byte. */
export async function compressPacked(packed: Buffer): Promise<Buffer> {
  const compressed = await brotliCompress(packed, {
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
 *
 * Only the compress-aware read path calls this — see the SENTINEL SCOPE note above for
 * why the first-byte sentinel check is collision-free there.
 */
export async function decompressPacked(value: Buffer): Promise<Buffer> {
  if (value.length > 0 && value[0] === PACKED_BROTLI_SENTINEL) {
    return brotliDecompress(value.subarray(1));
  }
  return value;
}

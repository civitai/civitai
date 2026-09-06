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
 * SENTINEL SCOPE: decompression is CONFINED to the compress-aware read paths
 * (`redis.packed.get(key, { compress: true })` and `redis.packed.mGet(keys,
 * { compress: true })`). The general decode path (`safeUnpack`, used by every other
 * packed read) NEVER touches this code, so the 0x01 sentinel is NOT a global invariant
 * on all packed values — it only applies on those confined paths.
 *
 * Two callers opt in today, and BOTH store an object, never a bare scalar, so the
 * sentinel is provably collision-free on the path (a msgpack map's first byte is always
 * a MAP marker 0x80–0x8f / 0xde / 0xdf — never 0x01):
 *   - `fetchThroughCache` — always the `{ data, cachedAt }` WRAPPER OBJECT.
 *   - `createCachedArray` / `createCachedObject` (`compress: true`) — every value it
 *     writes is a record: `{ ...result, cachedAt }`, the negative marker
 *     `{ [idKey]: id, notFound: true, cachedAt }`, and the debounce marker
 *     `{ [idKey]: id, debounce: true }`. `lookupFn` is typed `T extends object`, so a
 *     scalar cannot reach the write path.
 *
 * Do NOT enable `compress` for a caller that stores a bare scalar (a positive-fixint
 * 0x01 would be ambiguous with the sentinel).
 */
export const PACKED_BROTLI_SENTINEL = 0x01;
const PACKED_BROTLI_QUALITY = 6;

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

/**
 * Recorder for one codec call, in SECONDS (prom convention).
 *
 * 🔴 WHAT THE NUMBER ACTUALLY CONTAINS. The clock starts BEFORE the promisified call is enqueued
 * and stops when its callback resolves, so a sample is libuv threadpool QUEUE WAIT + codec work.
 * That is the right quantity for "what did compression cost this request", and it is deliberately
 * not CPU time: the value rises when the threadpool is busy with unrelated work (other brotli
 * calls, fs, dns, crypto) while the codec's own cost is unchanged. So read a rise as "the codec
 * PATH got slower", never as "brotli got more expensive", without a second signal to separate
 * them. Narrowing the window to the codec alone is not possible from JS — the enqueue and the
 * threadpool hand-off are both below the promisified boundary.
 *
 * WHY THE TIMING LIVES IN THIS MODULE rather than at the call sites: the codec is ASYNC, so
 * it runs on the libuv threadpool and never appears on the JS stack. A V8 CPU profile
 * therefore contains no `brotli*` frame at all — searching one for the codec returns zero,
 * which reads as "free" rather than "unobservable". And the redis command histogram cannot
 * stand in for it: that observation closes when the round trip does, while decode happens
 * strictly after — plus a compressed payload is SMALLER, so the command histogram actually
 * IMPROVES when the codec gets more expensive. This callback is the only signal that can
 * answer "what does the codec cost".
 *
 * Injected rather than imported so this module (reachable from the client bundle via
 * ./client) stays free of a static prom-client import; ./client passes a closure over the
 * globalThis metrics bridge. Undefined = no-op, so nothing here depends on prom being loaded.
 */
export type PackedCodecTimer = (op: 'compress' | 'decompress', seconds: number) => void;

/**
 * Brotli-compress an already-msgpack-packed Buffer and prepend the sentinel byte.
 *
 * `onTiming` (optional) receives the elapsed time of the compress call as this caller sees it —
 * threadpool queue wait included, so not CPU time; see PackedCodecTimer — labelled `compress`.
 */
export async function compressPacked(packed: Buffer, onTiming?: PackedCodecTimer): Promise<Buffer> {
  const startedAt = performance.now();
  const compressed = await brotliCompress(packed, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: PACKED_BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: packed.length,
    },
  });
  onTiming?.('compress', (performance.now() - startedAt) / 1000);
  return Buffer.concat([Buffer.from([PACKED_BROTLI_SENTINEL]), compressed]);
}

/**
 * Return the raw msgpack Buffer to feed to `unpack()`, transparently handling both the
 * brotli-sentinel-prefixed (new) and raw-msgpack (legacy) on-disk formats.
 *
 * Only the compress-aware read path calls this — see the SENTINEL SCOPE note above for
 * why the first-byte sentinel check is collision-free there.
 *
 * `onTiming` (optional) is called ONLY when a brotli-decompress actually ran, and records elapsed
 * time as this caller sees it — threadpool queue wait included; see PackedCodecTimer. The legacy
 * raw-msgpack passthrough deliberately records NOTHING: it is a sentinel check and a return,
 * not a codec call, and mixing those near-zero samples into the `decompress` histogram would
 * drag the quantiles toward "the cost of not decompressing" — a number that answers no
 * question. The sentinel discrimination therefore stays in this ONE function; the caller
 * never re-derives it (a second copy of that predicate is how the two drift apart).
 */
export async function decompressPacked(
  value: Buffer,
  onTiming?: PackedCodecTimer
): Promise<Buffer> {
  if (value.length > 0 && value[0] === PACKED_BROTLI_SENTINEL) {
    const startedAt = performance.now();
    const inflated = await brotliDecompress(value.subarray(1));
    onTiming?.('decompress', (performance.now() - startedAt) / 1000);
    return inflated;
  }
  return value;
}

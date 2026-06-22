/**
 * Tensor-metadata full-analysis read path with an in-process decoded-object LRU.
 *
 * BACKGROUND (the regression this guards against)
 * -----------------------------------------------
 * civitai #2500 caches the FULL parsed tensor analysis (`ModelTensorAnalysis`, incl.
 * the ~335 KB `tensors[]` array) in `redis.packed` so the `/api/v1/model-files/[id]/
 * tensor-metadata` accordion panel can render the tensor list. #2649 then made that
 * full-blob cache brotli-COMPRESSED at rest to reclaim ~80 GiB on next-redis-cluster.
 *
 * The compress win is real, but it moved cost onto the HOT read path on the shared
 * single-threaded `api-primary` event loop: every full read now does an async
 * brotli-DECOMPRESS (libuv threadpool) PLUS a SYNCHRONOUS msgpack `unpack()` of the
 * decompressed ~335 KB buffer into a big JS object — and that synchronous decode runs
 * ON the main event loop, on every accordion-open model-page view. For a popular model
 * many viewers hit the same file id, so the SAME decode is repeated per request and
 * concentrates into the api-primary 504 "waves" (see the cluster handoff
 * `dp_prod_api_primary_504_waves_readiness_cascade_2026_06_21`).
 *
 * THE FIX (this module)
 * ---------------------
 * A bounded in-process LRU of the already-DECODED `ModelTensorAnalysis`, keyed by file
 * id. An LRU HIT returns the parsed object with ZERO redis read, ZERO brotli decompress
 * and ZERO msgpack decode — so a popular model is decoded at most once per pod (until
 * eviction) instead of once per request. This keeps #2649's redis memory win intact
 * (the blob stays compressed+split in redis; this LRU only removes the REPEATED
 * hot-path decode) and is the relief-bearing change for the 504 waves.
 *
 * The LRU is bounded BOTH by item count AND by an approximate byte size so a burst of
 * distinct popular checkpoints can never grow the resident set without limit. On a
 * cache miss the underlying redis `fetchThroughCache` is still single-flighted (its own
 * per-pod in-flight map + distributed lock), so concurrent misses do not stampede the
 * origin parse.
 */

import { LRUCache } from 'lru-cache';
import { cacheHitCounter, cacheMissCounter } from '~/server/prom/client';
import type { ModelTensorAnalysis } from '~/utils/model-tensor-metadata';

const CACHE_NAME = 'tensor-metadata-full';

// Item-count cap: a small set of "hot" checkpoints is what drives the repeated decode,
// so a modest count is plenty. Tunable via env without a redeploy of intent.
const MAX_ITEMS = Number(process.env.TENSOR_METADATA_LRU_MAX_ITEMS ?? 64);

// Byte cap (approximate, on the decoded object) so a burst of large distinct models
// cannot grow the resident set unbounded. Default ~256 MiB of decoded analyses.
const MAX_SIZE_BYTES = Number(
  process.env.TENSOR_METADATA_LRU_MAX_SIZE_BYTES ?? 256 * 1024 * 1024
);

// Optional TTL (ms). 0 = no time-based eviction (the data is immutable by file content,
// so we rely on LRU + byte/count caps rather than time). Tunable via env.
const TTL_MS = Number(process.env.TENSOR_METADATA_LRU_TTL_MS ?? 0);

/**
 * Approximate the in-memory footprint of a decoded analysis. We deliberately avoid
 * JSON.stringify (that would itself walk + materialize the whole 335 KB+ object on the
 * hot path, defeating the purpose). Instead estimate from the tensor count: each
 * `ModelTensorInfo` is a small object with a name string + a short shape array. We use a
 * deliberately CONSERVATIVE ~640 B/tensor (V8 object overhead + a long dotted tensor-name
 * string + the shape array can run well past a naive 256 B), so the byte cap errs toward
 * evicting SOONER rather than under-counting and overshooting the cap. This is only a
 * heuristic, not exact — the authoritative hard bound on resident set is the ITEM-COUNT
 * cap (`MAX_ITEMS`); the byte cap is a secondary guard against a burst of huge models.
 */
function estimateAnalysisBytes(analysis: ModelTensorAnalysis): number {
  const tensorCount = analysis.tensors?.length ?? 0;
  const APPROX_BYTES_PER_TENSOR = 640;
  const BASE_BYTES = 4096;
  // never report 0 — lru-cache requires sizeCalculation > 0.
  return BASE_BYTES + tensorCount * APPROX_BYTES_PER_TENSOR;
}

// Always keep a definite count cap so the count-limit constructor overload is used
// (the ttl-limit overload would require `ttlAutopurge`). The byte cap and the optional
// TTL are spread in only when enabled, so `maxSize`+`sizeCalculation` always travel
// together and `ttl`+`ttlAutopurge` always travel together (lru-cache v11 invariants).
const decodedAnalysisLru = new LRUCache<number, ModelTensorAnalysis>({
  max: MAX_ITEMS > 0 ? MAX_ITEMS : 64,
  ...(MAX_SIZE_BYTES > 0
    ? { maxSize: MAX_SIZE_BYTES, sizeCalculation: estimateAnalysisBytes }
    : {}),
  ...(TTL_MS > 0 ? { ttl: TTL_MS, ttlAutopurge: false } : {}),
});

// Per-id in-flight decode promises. The LRU only caches RESOLVED objects, so without
// this a burst of concurrent misses for the SAME cold id (e.g. a popular model right
// after a deploy or an eviction, before the first `.set` lands) would each run the full
// decompress+decode — the exact cost we're removing, just confined to the warm-up window.
// Coalescing concurrent misses onto ONE shared promise closes that residual cold-burst.
// (The redis `fetchThroughCache` single-flight only dedups the ORIGIN PARSE on a redis
// MISS — it does NOT dedup the decompress+decode of a redis HIT, which is the wave cost.)
const inFlightDecodes = new Map<number, Promise<ModelTensorAnalysis>>();

/**
 * Return the full decoded tensor analysis for a file id, served from the in-process
 * LRU when warm. On a miss, `fetchDecoded` is invoked (the redis-backed compressed
 * `fetchThroughCache` path), the result is stored, and returned. Concurrent misses for
 * the same id share a single in-flight decode (no thundering herd while cold).
 *
 * @param fileId        model file id (the cache key)
 * @param fetchDecoded  miss handler that produces the decoded analysis (redis-backed)
 */
export async function getFullTensorAnalysisCached(
  fileId: number,
  fetchDecoded: () => Promise<ModelTensorAnalysis>
): Promise<ModelTensorAnalysis> {
  const cached = decodedAnalysisLru.get(fileId);
  if (cached !== undefined) {
    cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: 'lruCache' });
    return cached;
  }

  // Join an in-flight decode for this id if one exists (counts as a hit — it avoids a
  // second decode). Only the request that STARTS the decode is counted as a miss.
  const pending = inFlightDecodes.get(fileId);
  if (pending) {
    cacheHitCounter.inc({ cache_name: CACHE_NAME, cache_type: 'lruCache' });
    return pending;
  }

  cacheMissCounter.inc({ cache_name: CACHE_NAME, cache_type: 'lruCache' });
  const decodePromise = (async () => {
    // `.set` only on SUCCESS; on throw nothing is cached. `finally` always clears the
    // in-flight entry so a rejected decode does not wedge future reads.
    const analysis = await fetchDecoded();
    decodedAnalysisLru.set(fileId, analysis);
    return analysis;
  })().finally(() => {
    inFlightDecodes.delete(fileId);
  });
  inFlightDecodes.set(fileId, decodePromise);
  return decodePromise;
}

/**
 * Invalidate the in-process cache for a file id. No production caller today (tensor
 * metadata is immutable per file-content and has no redis bust path), but this is the
 * hook a future re-scan / parser-version change would call to force a re-decode without
 * waiting for LRU eviction or a pod restart. Clears both the cached object and any
 * in-flight decode.
 */
export function bustFullTensorAnalysis(fileId: number): void {
  decodedAnalysisLru.delete(fileId);
  inFlightDecodes.delete(fileId);
}

/** Test/maintenance helpers — not used on the request path. */
export const __tensorMetadataLruInternals = {
  clear: () => {
    decodedAnalysisLru.clear();
    inFlightDecodes.clear();
  },
  get size() {
    return decodedAnalysisLru.size;
  },
  get inFlightSize() {
    return inFlightDecodes.size;
  },
  has: (fileId: number) => decodedAnalysisLru.has(fileId),
  peek: (fileId: number) => decodedAnalysisLru.peek(fileId),
};

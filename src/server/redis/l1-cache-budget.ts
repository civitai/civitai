/**
 * Per-pod L1 (in-process LRU) heap byte budget — the single source of truth for the
 * `localMaxBytes` cap of every L1-enabled cache in `caches.ts`.
 *
 * Each L1 cache is byte-bounded (deterministic `roughSizeOf` estimator, see
 * `cache-helpers.ts` / `lru-cache.ts`) so a per-value size spike can never blow the
 * cap. The SUM of these per-cache budgets is the pod's total L1 footprint; it MUST
 * stay under `L1_TOTAL_BYTE_CEILING`. `l1-cache-budget.test.ts` enforces this
 * invariant so adding/enlarging an L1 cache cannot silently exceed the ceiling.
 *
 * Heap safety: the dp-prod pods run with a 4096MB V8 old-space limit and a
 * >3200MB heap-headroom alert. The ceiling below (96MB) is <2.5% of old-space and
 * far under the alert threshold; `roughSizeOf` over-estimates retained bytes
 * (2× UTF-16 JSON length + fixed overhead, while ASCII strings cost ≤1 byte/char
 * internally and V8 dedupes), so the true resident footprint is lower still.
 */
const MB = 1024 * 1024;

export const L1_CACHE_BYTE_BUDGETS = {
  // userBasicCache — tiny per-user records (id/username/etc.).
  userBasic: 4 * MB,
  // imageResourcesCache — which model versions an image used (attribution metadata).
  imageResources: 12 * MB,
  // imageTagsCache — the heaviest remaining L1 value (composite image-tag rows).
  imageTags: 16 * MB,
  // tagIdsForImagesCache — { imageId, tags: number[] }; tag-id arrays are small but
  // this holds a large hot working set of feed imageIds (enlarged 2026-07 to recover
  // its Redis command volume — feed streams distinct imageIds).
  tagIdsForImages: 30 * MB,
  // tagCache (basic-tags) — { id, name, type, nsfwLevel, unlisted? }; tiny values,
  // sized to hold the hot tag catalog for a near-100% feed hit ratio.
  basicTags: 20 * MB,
} as const;

/**
 * Hard per-pod ceiling for the SUM of all L1 byte budgets. Enforced by
 * `l1-cache-budget.test.ts`. Raise ONLY with proven heap headroom vs the 4096MB
 * old-space limit / >3200MB heap-headroom alert.
 */
export const L1_TOTAL_BYTE_CEILING = 96 * MB;

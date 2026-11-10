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
 * >3200MB heap-headroom alert. The ceiling below (160MB, the worst case with every
 * switched tier at its larger size) is <4% of old-space and far under the alert threshold; `roughSizeOf` over-estimates retained bytes
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
  // cosmeticCache (cosmetics2) — { id, name, type, data, source, flags } per cosmetic, the
  // catalog every avatar, badge and sticker lookup reads. Only used while its switch is on.
  cosmetics: 2 * MB,
} as const;

/**
 * The larger tier of an L1 whose Flipt switch (`~/server/redis/l1-switches`) also changes how much it
 * holds. The cache holds EITHER its entry above OR its entry here, never both: the switch rebuilds the
 * L1 at the other tier's caps (`localLimits` in @civitai/redis cached-array). So the worst-case pod
 * footprint takes, per cache, the larger of the two.
 */
export const L1_SWITCHED_BYTE_BUDGETS = {
  // tagIdsForImagesCache with `tag-ids-for-images-l1-large` on: the same values, held 10 minutes
  // instead of 3 and up to 200k entries instead of 50k (sized so the byte cap binds at about the
  // same point as the entry cap: a 30-tag entry estimates at ~0.5KB).
  tagIdsForImages: 96 * MB,
} as const satisfies Partial<Record<keyof typeof L1_CACHE_BYTE_BUDGETS, number>>;

/** Per-cache worst case: the larger of a cache's base budget and its switched tier, if any. */
export function worstCaseL1Bytes(): number {
  let total = 0;
  for (const [name, bytes] of Object.entries(L1_CACHE_BYTE_BUDGETS)) {
    const switched = (L1_SWITCHED_BYTE_BUDGETS as Record<string, number | undefined>)[name];
    total += Math.max(bytes, switched ?? 0);
  }
  return total;
}

/**
 * Hard per-pod ceiling for the worst-case SUM of all L1 byte budgets (every cache at its larger
 * tier). Enforced by `l1-cache-budget.test.ts`. Raise ONLY with proven heap headroom vs the 4096MB
 * old-space limit / >3200MB heap-headroom alert.
 *
 * Raised 96MB -> 160MB for the `tag-ids-for-images-l1-large` tier (worst case 84MB -> 150MB). The
 * extra ~66MB of budget (plus the larger LRU's preallocated slots, about 48 bytes x its entry cap)
 * is under 2% of the old-space limit, and it only exists while that flag is on. Before turning the
 * flag on anywhere, check that process's peak heap leaves that much room under the alert.
 */
export const L1_TOTAL_BYTE_CEILING = 160 * MB;

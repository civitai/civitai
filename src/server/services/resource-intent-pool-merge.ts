import { createHash } from 'crypto';

/**
 * The POOL_MERGE list as the offline co-occurrence screen measured it: up to 25 gated
 * co-occurrence models and BASE's popularity models, interleaved co-occurrence first, 50 in all.
 * That screen always had a baseModel; see `poolMergeModelIds` for the no-baseModel order. No stage
 * 3. Imports nothing from the app, so a study script can load it.
 */

/** Co-occurrence models reserved in the merged list. */
export const POOL_MERGE_COOC_SLOTS = 25;
/**
 * Width the screen merged at, and the most this arm ever returns: limits above 50 were never
 * screened, so they get these 50 (unlike HYBRID_10, which honours the limit). A narrower request
 * is this list's prefix.
 */
export const POOL_MERGE_LIST_MODELS = 50;
/** Gated co-occurrence models handed to the merge (the screen's `coocList`). */
export const POOL_MERGE_COOC_LIST_MODELS = 50;
/** BASE pool width, the screen's 100, whatever the request's cap. */
export const POOL_MERGE_BASE_MODELS = 2 * POOL_MERGE_LIST_MODELS;

// Copied verbatim from the screen; `resource-intent-pool-merge.seam.test.ts` holds it there.
function distinct(ids: readonly number[]): number[] {
  return [...new Set(ids)];
}
/**
 * POOL_MERGE: reserved MODEL slots — ≤`slots` from `a` (its order), the rest from `base` (its order,
 * minus models already in a's slots) up to `cap`, interleaved a-first. A short `a` leaves its unused
 * slots to `base`.
 */
export function mergeReservedK(
  a: readonly number[],
  base: readonly number[],
  slots: number,
  cap: number
): number[] {
  const R = distinct(a).slice(0, slots);
  const inR = new Set(R);
  const B = distinct(base)
    .filter((id) => !inR.has(id))
    .slice(0, cap - R.length);
  const out: number[] = [];
  for (let i = 0; out.length < R.length + B.length; i++) {
    if (i < R.length) out.push(R[i]);
    if (i < B.length) out.push(B[i]);
  }
  return out;
}

/**
 * POOL_MERGE with no baseModel gate: all of `a` (its order, distinct) up to `cap`, then `base` (its
 * order, minus models already listed) in whatever slots `a` left. No reserved slots, no interleave.
 */
export function backfillAfter(
  a: readonly number[],
  base: readonly number[],
  cap: number
): number[] {
  const A = distinct(a).slice(0, cap);
  const inA = new Set(A);
  return [...A, ...distinct(base).filter((id) => !inA.has(id))].slice(0, cap);
}

/**
 * The merged model ids for a request cap: always merged at 50, then cut to `min(cap, 50)`, so a
 * narrower cap gets the 50-wide list's prefix. Merging at the cap itself would not: BASE would get
 * only `cap - 25` slots, and below 25 `mergeReservedK` slices BASE with a negative bound.
 *
 * `interleaveBase` is whether the request had a baseModel gate. With one, BASE is popularity within
 * that ecosystem and interleaves, as screened (`mergeReservedK`). Without one, BASE is global
 * popularity: interleaved, the same popular add-ons would fill every other slot of every such
 * response whatever the prompt, so it only backfills (`backfillAfter`).
 */
export function poolMergeModelIds(
  cooc: readonly number[],
  base: readonly number[],
  cap: number,
  { interleaveBase }: { interleaveBase: boolean }
): number[] {
  const merged = interleaveBase
    ? mergeReservedK(cooc, base, POOL_MERGE_COOC_SLOTS, POOL_MERGE_LIST_MODELS)
    : backfillAfter(cooc, base, POOL_MERGE_LIST_MODELS);
  return merged.slice(0, Math.min(cap, POOL_MERGE_LIST_MODELS));
}

/**
 * Hashes the merge constants and what the merge produces on a fixed fixture, so the cache key and
 * the shadow row move when either does.
 */
function poolMergeFingerprint() {
  const cooc = [9, 1, 2, 2, 3, 7];
  const base = [1, 4, 5, 6, 7, 8, 10, 11];
  // Co-occurrence lists of 30 (BASE backfills past slot 30) and 60 (fills all 50), so changing how
  // many co-occurrence models a no-baseModel list keeps moves the hash.
  const longBase = Array.from({ length: 60 }, (_, i) => 2000 + i);
  const longCooc = (n: number) => Array.from({ length: n }, (_, i) => 1000 + i);
  return {
    slots: POOL_MERGE_COOC_SLOTS,
    listModels: POOL_MERGE_LIST_MODELS,
    coocListModels: POOL_MERGE_COOC_LIST_MODELS,
    baseModels: POOL_MERGE_BASE_MODELS,
    merged: [1, 4, 50].map((cap) => poolMergeModelIds(cooc, base, cap, { interleaveBase: true })),
    small: mergeReservedK(cooc, base, 2, 5),
    noBaseModel: [1, 4, 50].map((cap) =>
      poolMergeModelIds(cooc, base, cap, { interleaveBase: false })
    ),
    noBaseModelLong: [30, 60].map((n) =>
      poolMergeModelIds(longCooc(n), longBase, 50, { interleaveBase: false })
    ),
  };
}

export const RESOURCE_INTENT_POOL_MERGE_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(poolMergeFingerprint()))
  .digest('hex');

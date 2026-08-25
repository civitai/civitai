/**
 * The single definition of "this response will be edge-cached".
 *
 * Extracted out of `src/pages/api/trpc/[trpc].ts` so there is exactly ONE place the
 * condition is written. It used to be an inline expression in `responseMeta`, which
 * meant a test asserting the cache outcome of a middleware chain had to RE-DECLARE it —
 * and a re-declared predicate is a spelled guard, not a structural one: the copy in the
 * test keeps agreeing with itself while the real one is changed underneath it. Anything
 * that wants to assert "this response would/would not carry a `Cache-Control`" must
 * import this function, so that changing it is visible to those assertions.
 *
 * Deliberately a type predicate, and deliberately generic over the caller's own cache
 * type: `responseMeta` reads `browserTTL` / `staleWhileRevalidate` / `tags` off the same
 * object inside the guarded block, so narrowing to a fixed local shape would throw those
 * away. `cache is T` narrows off only `null | undefined`.
 *
 * ⚠️ The leading `!!cache.edgeTTL` is load-bearing and NOT redundant with `> 0`: it is
 * what rejects `edgeTTL === 0`, which is precisely the value `edgeCacheIt` writes when a
 * resolver opts out (`ctx.cache.skip`). Because it short-circuits on 0 first, relaxing
 * the comparison alone — `> 0` to `>= 0` — changes nothing; widening this predicate to
 * treat 0 as cacheable requires dropping the `!!` as well. Both halves are the guard.
 */
export type EdgeCacheReadable = {
  edgeTTL?: number | null;
};

export function willEdgeCache<T extends EdgeCacheReadable>(
  cache: T | null | undefined
): cache is T {
  return !!cache && !!cache.edgeTTL && cache.edgeTTL > 0;
}

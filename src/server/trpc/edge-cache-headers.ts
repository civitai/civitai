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
 * ⚠️ Do not widen this predicate: `edgeTTL === 0` is exactly what `edgeCacheIt` writes
 * when a resolver opts out (`ctx.cache.skip`), and treating 0 as cacheable would undo
 * every such opt-out at once.
 *
 * But be precise about WHY, because the obvious reading is wrong and was written down
 * here once already. At RUNTIME the two halves are redundant on `number | null |
 * undefined`: `!!cache.edgeTTL` and `cache.edgeTTL > 0` reject the same values, so
 * NEITHER single-half mutant is killable — measured, both survive the suite 12/12
 * (`> 0` → `>= 0`, and dropping the `!!` while keeping `> 0`). What `!!cache.edgeTTL`
 * actually buys is TYPE NARROWING: remove it and `cache.edgeTTL > 0` stops compiling
 * with `TS18049: 'cache.edgeTTL' is possibly 'null' or 'undefined'`.
 *
 * The consequence for anyone testing this: a mutant that changes both halves at once
 * proves nothing about either. Isolate them, and expect a widening mutation to be caught
 * by `tsc`, not by vitest.
 *
 * KNOWN LIMIT, stated rather than papered over: extracting this makes the predicate
 * single-sourced, but nothing asserts that `responseMeta` still CALLS it. Measured —
 * re-inline the condition at the call site in `src/pages/api/trpc/[trpc].ts` and the
 * suite stays fully green. Closing that seam properly means moving the header-building
 * out of `responseMeta` so a test can drive the real thing; a test that greps the route
 * for this import would be a spelled guard, i.e. the exact shape this file exists to
 * replace, so it is deliberately not done here.
 */
export type EdgeCacheReadable = {
  edgeTTL?: number | null;
};

export function willEdgeCache<T extends EdgeCacheReadable>(
  cache: T | null | undefined
): cache is T {
  return !!cache && !!cache.edgeTTL && cache.edgeTTL > 0;
}

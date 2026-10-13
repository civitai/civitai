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
 * The header-building itself now lives here too (`buildTrpcCacheHeaders` below), and
 * `src/server/__tests__/trpc-handler-wiring.test.ts` drives the route's REAL `responseMeta`
 * through the options object it hands the adapter — so a route that stopped using this
 * module, or re-inlined a different condition, is asserted on by behaviour rather than by a
 * grep of the route's source.
 */
import { isBlockTokenQueryPath } from '~/shared/constants/block-token-transport.constants';

export type EdgeCacheReadable = {
  edgeTTL?: number | null;
};

export function willEdgeCache<T extends EdgeCacheReadable>(
  cache: T | null | undefined
): cache is T {
  return !!cache && !!cache.edgeTTL && cache.edgeTTL > 0;
}

export type TrpcResponseCache = EdgeCacheReadable & {
  browserTTL?: number | null;
  staleWhileRevalidate?: number | null;
  tags?: string[] | null;
};

/**
 * The response headers `responseMeta` in `src/pages/api/trpc/[trpc].ts` returns. Built here,
 * not inline in the route, so a test can drive the real header logic.
 *
 * 🔴 BLOCK-TOKEN QUERIES ARE NEVER CACHEABLE. If ANY call in the request is in
 * `BLOCK_TOKEN_QUERY_PROCEDURES`, the response is `no-store` and this returns before the public
 * branch is consulted. Keyed on the procedure PATH, deliberately not on `ctx.cache`:
 *   - `ctx.cache` is seeded per SESSION (`createContext` gives a sessionless caller a positive
 *     edge TTL, and these procedures are callable sessionless — the bearer is in the input), and
 *     any middleware can rewrite it, so an opt-out written there is one middleware away from being
 *     overwritten (see the `edgeCacheIt` notes in `src/utils/trpc.ts`);
 *   - the path is fixed by the request itself, and covers a GET from an old SDK as well as the
 *     POST the current client sends — and errors, which otherwise carry no header at all.
 * A batched request mixing one of these with a cacheable query is `no-store` as a whole: one
 * response carries both results, so it may only be cached if every part may.
 */
export function buildTrpcCacheHeaders({
  cache,
  type,
  errorCount,
  paths,
}: {
  cache: TrpcResponseCache | null | undefined;
  type: string;
  errorCount: number;
  paths: readonly string[] | undefined;
}): { headers: Record<string, string>; edgeCached: boolean } {
  if (paths?.some(isBlockTokenQueryPath)) {
    return { headers: { 'Cache-Control': 'no-store' }, edgeCached: false };
  }
  const headers: Record<string, string> = {};
  if (willEdgeCache(cache) && type === 'query' && errorCount === 0) {
    headers['Cache-Control'] = [
      'public',
      `max-age=${cache.browserTTL ?? 0}`,
      `s-maxage=${cache.edgeTTL ?? 0}`,
      `stale-while-revalidate=${cache.staleWhileRevalidate ?? 0}`,
    ].join(', ');
    if (cache.tags) headers['Cache-Tag'] = cache.tags.join(', ');
    return { headers, edgeCached: true };
  }
  return { headers, edgeCached: false };
}

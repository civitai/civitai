// In-process (per-pod), single-slot TTL memoize for a GLOBAL async fetcher.
//
// Wraps a `() => Promise<T>` whose result is identical for every user/request
// (e.g. the global system-cache blobs) and collapses repeated calls within a
// short TTL into ~1 underlying fetch / TTL / pod. This is the exact shape of
// `getClientConfigCached` in src/server/trpc.ts, factored out for reuse.
//
// Fail-open: only a *resolved* value is memoized. If the fetcher REJECTS, the
// rejection propagates to the caller unchanged and NOTHING is cached — so a
// transient backing-store failure is never frozen in as a "fresh" (e.g. empty)
// value; the very next call retries. This preserves whatever fail-open/fail-safe
// behavior the underlying getter already has (it either throws, or resolves with
// its own fallback value which is then a legitimate cacheable result).
//
// 🔴 NEVER use this for user/session-keyed values — it is a single module-scope
// slot with no key, so a per-user value would leak across users. Only wrap
// fetchers whose output does not depend on the request/user.
export type TtlMemo<T> = (() => Promise<T>) & {
  /** Drop the cached value (e.g. in tests, or an explicit invalidation). */
  clear: () => void;
};

export function createTtlMemo<T>(
  fetcher: () => Promise<T>,
  ttlMs: number,
  // Injectable clock so tests can advance time deterministically without
  // wall-clock sleeps. Defaults to Date.now in production.
  now: () => number = Date.now
): TtlMemo<T> {
  let cache: { value: T; expiresAt: number } | null = null;

  const memo = (async () => {
    const t = now();
    if (cache && cache.expiresAt > t) return cache.value;
    // Await BEFORE assigning: a rejection skips the cache write (fail-open),
    // exactly like getClientConfigCached only caching successful reads.
    const value = await fetcher();
    cache = { value, expiresAt: now() + ttlMs };
    return value;
  }) as TtlMemo<T>;

  memo.clear = () => {
    cache = null;
  };

  return memo;
}

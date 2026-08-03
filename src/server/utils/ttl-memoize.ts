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
  now: () => number = Date.now,
  // When `freeze` is true, a resolved object/array value is Object.freeze()d
  // (shallow) before it is stored in — and returned from — the single memo slot.
  // The SAME reference is served to every caller for the whole TTL window, so
  // this enforces the "don't mutate the shared cached blob" invariant
  // STRUCTURALLY: an accidental `.push()`/`.sort()`/element write throws (strict
  // mode) instead of silently corrupting the shared blob for every concurrent
  // request on the pod. No-op for primitive/null values. Opt-in — most memoized
  // values (e.g. the raw sysRedis strings, which are re-parsed into a fresh
  // object per call outside the memo) don't need it.
  { freeze = false }: { freeze?: boolean } = {}
): TtlMemo<T> {
  let cache: { value: T; expiresAt: number } | null = null;

  const memo = (async () => {
    const t = now();
    if (cache && cache.expiresAt > t) return cache.value;
    // Await BEFORE assigning: a rejection skips the cache write (fail-open),
    // exactly like getClientConfigCached only caching successful reads.
    const value = await fetcher();
    // Freeze in place (Object.freeze returns the same ref) so the value we
    // cache AND return is immutable; keep `value` typed as T for callers.
    if (freeze && value !== null && typeof value === 'object') Object.freeze(value);
    cache = { value, expiresAt: now() + ttlMs };
    return value;
  }) as TtlMemo<T>;

  memo.clear = () => {
    cache = null;
  };

  return memo;
}

// Keyed variant of createTtlMemo for a GLOBAL-per-key async fetcher — i.e. a
// fetcher whose result depends ONLY on a small, bounded key (not on the
// user/session), e.g. the per-domain "latest bug/changelog" timestamp, a
// category `type`, or a `DomainColor`. Each distinct key gets its own
// independent single-slot TTL memo (same fail-open semantics: only a resolved
// value is cached, a rejection propagates uncached).
//
// 🔴 The key space MUST be bounded (an enum, a domain list, …). This holds one
// slot per distinct key forever, so a per-user / unbounded key would both leak
// memory AND — because a slot is user-independent by contract — is still only
// safe for values that don't depend on the request/user beyond the key itself.
export type KeyedTtlMemo<T> = ((key: string) => Promise<T>) & {
  /** Drop one key's cached value, or (no arg) every key's. */
  clear: (key?: string) => void;
};

export function createKeyedTtlMemo<T>(
  fetcher: (key: string) => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
  opts: { freeze?: boolean } = {}
): KeyedTtlMemo<T> {
  const slots = new Map<string, TtlMemo<T>>();

  const keyed = ((key: string) => {
    let slot = slots.get(key);
    if (!slot) {
      slot = createTtlMemo(() => fetcher(key), ttlMs, now, opts);
      slots.set(key, slot);
    }
    return slot();
  }) as KeyedTtlMemo<T>;

  keyed.clear = (key?: string) => {
    if (key === undefined) slots.clear();
    else slots.get(key)?.clear();
  };

  return keyed;
}

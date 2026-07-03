// Replication-lag tracking primitive. A write "marks fresh" an entity key; a read "checks stale" to
// decide whether to route to the primary (write) pool instead of a lagging replica within the delay
// window. This is a DB read-consistency concern, so it lives next to the pool factories — but it stays
// redis-agnostic: the flag store is injected (DI). @civitai/db does NOT depend on @civitai/redis; a
// caller passes any store satisfying `LagStore` (the monolith's redis, @civitai/redis, a test double).
//
// It's also pool-agnostic: `isStale` returns a boolean and the caller picks `stale ? writePool :
// readPool`. Domain-specific concerns (which entities lag, key namespacing, a global Flipt kill-switch)
// stay in the caller.

/** The minimal flag store the tracker needs. Generic over the key type `K` so callers with branded/
 * templated redis keys (e.g. `RedisKeyTemplateCache`) pass their client directly — @civitai/db never
 * names a redis key type. */
export type LagStore<K extends string = string> = {
  get(key: K): Promise<string | null>;
  set(key: K, value: string, opts: { EX: number }): Promise<unknown>;
};

export type LagTracker<K extends string = string> = {
  /** True when a recent write flagged this key AND lag routing is enabled — route reads to the primary. */
  isStale(key: K): Promise<boolean>;
  /** Flag a fresh write so reads within the delay window route to the primary. No-op when disabled. */
  markFresh(key: K): Promise<void>;
};

/** The store, a nullable store (degrades to always-fresh when null), or a thunk that lazily resolves one.
 * A thunk lets a caller pass its lazy client factory directly (e.g. `getRedis`) without wiring its own
 * memoization, and keeps importing this from building a connection. A NON-null resolution is memoized;
 * a `null` is not, so a thunk that returns null before its store is ready is picked up on a later call. */
export type LagStoreInput<K extends string = string> =
  | LagStore<K>
  | null
  | (() => LagStore<K> | null);

export function createLagTracker<K extends string = string>(opts: {
  store: LagStoreInput<K>;
  /** Lag window in seconds. Anything non-positive (incl. NaN/Infinity, e.g. a bad env value) disables
   * routing entirely — isStale always false, markFresh no-ops — so a disabled tracker never touches the
   * store and never writes an invalid TTL. */
  delaySeconds: number;
}): LagTracker<K> {
  const { store, delaySeconds } = opts;
  const enabled = Number.isFinite(delaySeconds) && delaySeconds > 0;

  // Memoize only a non-null resolution (see LagStoreInput): a null result re-resolves next call.
  let resolved: LagStore<K> | null = null;
  const getStore = (): LagStore<K> | null => {
    if (resolved) return resolved;
    const s = typeof store === 'function' ? store() : store;
    if (s) resolved = s;
    return s;
  };

  return {
    isStale: async (key) => {
      if (!enabled) return false;
      const s = getStore();
      return s ? Boolean(await s.get(key)) : false;
    },
    markFresh: async (key) => {
      if (!enabled) return;
      await getStore()?.set(key, 'true', { EX: delaySeconds });
    },
  };
}

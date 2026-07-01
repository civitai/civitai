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
 * The thunk is resolved once on first use and memoized — so a caller can pass its lazy client factory
 * directly (e.g. `getRedis`) without wiring its own memoization, and importing this never builds a
 * connection. */
export type LagStoreInput<K extends string = string> =
  | LagStore<K>
  | null
  | (() => LagStore<K> | null);

export function createLagTracker<K extends string = string>(opts: {
  store: LagStoreInput<K>;
  /** Lag window in seconds. `<= 0` disables routing entirely (isStale always false, markFresh no-ops) —
   * so a disabled tracker never touches the store. */
  delaySeconds: number;
}): LagTracker<K> {
  const { store, delaySeconds } = opts;
  let resolved: LagStore<K> | null | undefined;
  const getStore = () =>
    resolved !== undefined ? resolved : (resolved = typeof store === 'function' ? store() : store);
  return {
    isStale: async (key) => {
      if (delaySeconds <= 0) return false;
      const s = getStore();
      return s ? Boolean(await s.get(key)) : false;
    },
    markFresh: async (key) => {
      if (delaySeconds <= 0) return;
      await getStore()?.set(key, 'true', { EX: delaySeconds });
    },
  };
}

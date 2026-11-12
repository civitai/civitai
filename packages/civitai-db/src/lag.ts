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

export const DEFAULT_LAG_READ_TIMEOUT_MS = 200;

class LagReadTimeoutError extends Error {
  constructor(ms: number) {
    super(`replication-lag flag read timed out after ${ms}ms`);
    this.name = 'LagReadTimeoutError';
  }
}

/** Race `p` against a timer. The abandoned read is not cancelled; Promise.race keeps a handler on it,
 * so its late rejection never surfaces as an unhandledRejection. */
function withReadTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LagReadTimeoutError(ms)), ms);
  });
  return Promise.race([p, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createLagTracker<K extends string = string>(opts: {
  store: LagStoreInput<K>;
  /** Lag window in seconds. Anything non-positive (incl. NaN/Infinity, e.g. a bad env value) disables
   * routing entirely — isStale always false, markFresh no-ops — so a disabled tracker never touches the
   * store and never writes an invalid TTL. */
  delaySeconds: number;
  /** Bound on the flag READ in `isStale`, in ms (default 200). A read that misses it, or rejects,
   * reads as fresh — the replica — which is what an absent flag already means. `<= 0` disables the
   * bound. The flag store is usually a shared cache whose client waits far longer than a page read
   * is worth while it is unreachable; this keeps that wait off every read the tracker fronts. */
  readTimeoutMs?: number;
  /** Called once per failed flag read, with why (`timeout` or `error`). Observability only. */
  onReadFailure?: (reason: 'timeout' | 'error', err: unknown) => void;
}): LagTracker<K> {
  const { store, delaySeconds, onReadFailure } = opts;
  const readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_LAG_READ_TIMEOUT_MS;
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
      if (!s) return false;
      try {
        return Boolean(
          await withReadTimeout(
            Promise.resolve().then(() => s.get(key)),
            readTimeoutMs
          )
        );
      } catch (err) {
        try {
          onReadFailure?.(err instanceof LagReadTimeoutError ? 'timeout' : 'error', err);
        } catch {
          // Observability only: a throwing hook must not turn a routing decision into an error.
        }
        return false;
      }
    },
    markFresh: async (key) => {
      if (!enabled) return;
      await getStore()?.set(key, 'true', { EX: delaySeconds });
    },
  };
}

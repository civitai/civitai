/**
 * Dismissal stores — one factory for anything a user can dismiss.
 *
 * Every dismissal surface has needed the same four things: a set of ids held in
 * ONE storage slot (never a key per item, which grows forever and nothing ever
 * collects), add-without-duplicating, prune to the ids that still exist, and a
 * single writer so state and storage can't disagree. Only WHERE the set lives
 * differs, so that's the parameter.
 *
 * `buckets` exist because the announcement carousel partitions its set by
 * placement (`site` / `generator` / `training`) inside one cookie payload. A
 * consumer with no partition passes one bucket and never names it again.
 *
 * The set policy itself lives in `~/utils/dismissal-set` as pure functions, so it
 * can be tested and reasoned about without a store or a storage backend.
 *
 * Storage adapters are deliberately not unified into one mechanism:
 *   - announcements use a COOKIE because the SERVER reads the set to render the
 *     carousel at its true height from frame 0. Its parser is the single parser
 *     used by both sides — a divergence there is a hydration mismatch — so the
 *     adapter wraps that module rather than reimplementing it.
 *   - the generator's experimental warnings use localStorage; nothing there
 *     renders during SSR.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { addDismissals, pruneDismissals } from '~/utils/dismissal-set';

/** Dismissed ids per bucket. Every bucket is always present. */
export type DismissalBuckets<B extends string, T> = Record<B, T[]>;

export type DismissalStorage<B extends string, T> = {
  /**
   * Read the persisted set. Must return every bucket, and must be safe to call
   * on the server — returning the empty set there.
   */
  read: () => DismissalBuckets<B, T>;
  /** Persist the whole set. No-op on the server. */
  write: (value: DismissalBuckets<B, T>) => void;
};

export type DismissalStore<B extends string, T> = {
  /** The raw store, for callers that want their own selector. */
  useStore: UseBoundStore<StoreApi<{ dismissed: DismissalBuckets<B, T> }>>;
  /** Reactive read of one bucket. */
  useDismissed: (bucket?: B) => T[];
  /** Non-reactive read of one bucket. */
  getDismissed: (bucket?: B) => T[];
  dismiss: (ids: T | T[], bucket?: B) => void;
  /**
   * Drop ids no longer in `live`. Call only once the live set has RESOLVED —
   * see `pruneDismissals`, which cannot tell "nothing is live" from "nothing has
   * loaded".
   */
  prune: (live: Iterable<T>, bucket?: B) => void;
};

// Stable reference so a bucket that isn't in storage yet doesn't churn deps.
const EMPTY: never[] = [];

export function createDismissalStore<T, B extends string = string>({
  storage,
  defaultBucket,
}: {
  storage: DismissalStorage<B, T>;
  defaultBucket: B;
}): DismissalStore<B, T> {
  const useStore = create<{ dismissed: DismissalBuckets<B, T> }>(() => ({
    dismissed: storage.read(),
  }));

  // The single writer: state and storage move together, so no reader of either
  // can see the other's stale value.
  const commit = (bucket: B, ids: T[]) => {
    const dismissed = { ...useStore.getState().dismissed, [bucket]: ids } as DismissalBuckets<B, T>;
    useStore.setState({ dismissed });
    storage.write(dismissed);
  };

  const resolve = (bucket?: B) => bucket ?? defaultBucket;
  const getDismissed = (bucket?: B) => useStore.getState().dismissed[resolve(bucket)] ?? EMPTY;

  return {
    useStore,
    getDismissed,

    useDismissed: (bucket) => useStore((state) => state.dismissed[resolve(bucket)] ?? EMPTY),

    dismiss: (ids, bucket) => {
      const next = addDismissals(getDismissed(bucket), ids);
      if (next) commit(resolve(bucket), next);
    },

    prune: (live, bucket) => {
      const pruned = pruneDismissals(getDismissed(bucket), live);
      if (pruned) commit(resolve(bucket), pruned);
    },
  };
}

/**
 * A localStorage-backed adapter: the whole bucket map under one key as JSON.
 *
 * `onRead` runs on the single read at store creation — the hook for collecting
 * keys an earlier scheme left behind.
 */
export function localStorageDismissalStorage<T, B extends string>({
  key,
  buckets,
  isId,
  onRead,
}: {
  key: string;
  buckets: readonly B[];
  /** Guards a persisted payload written by an older or tampered-with client. */
  isId: (value: unknown) => value is T;
  onRead?: () => void;
}): DismissalStorage<B, T> {
  const empty = () =>
    Object.fromEntries(buckets.map((bucket) => [bucket, [] as T[]])) as DismissalBuckets<B, T>;

  return {
    read: () => {
      onRead?.();
      if (typeof window === 'undefined' || !window.localStorage) return empty();
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return empty();
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return empty();
        const source = parsed as Record<string, unknown>;
        const result = empty();
        for (const bucket of buckets) {
          const value = source[bucket];
          if (Array.isArray(value)) result[bucket] = value.filter(isId);
        }
        return result;
      } catch {
        // Unreadable or unparseable storage reads as "nothing dismissed" rather
        // than breaking the surface that renders the dismissible thing.
        return empty();
      }
    },

    write: (value) => {
      if (typeof window === 'undefined' || !window.localStorage) return;
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // A full or blocked localStorage must not break a dismissal.
      }
    },
  };
}

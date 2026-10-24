import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';

/**
 * On a non-SWR cache, `bust()` writes a debounce marker with `EX = debounceTime`. While that marker
 * is readable, a fetch must go to the origin and NOT write the result back — the window exists so a
 * read from a lagging replica cannot be re-cached for a full ttl right after a write. Once the marker
 * expires the id is a plain miss and is cached again.
 *
 * The redis stub is a Map that honours `EX` against the (fake) clock, so the marker expires exactly
 * as it would in Redis.
 */

type Row = { id: number; v: string };
const KEY = 'packed:caches:test-debounce' as RedisKeyTemplateCache;
const keyFor = (id: number) => `${KEY}:${id}`;
const T0 = new Date('2026-01-01T00:00:00Z').getTime();

// `debounceTime` omitted = the builder default. `swr` builds a stale-while-revalidate cache, whose
// public bust is invalidate().
function build({ debounceTime, swr = false }: { debounceTime?: number; swr?: boolean } = {}) {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (Date.now() >= e.expiresAt) {
      store.delete(k);
      return null;
    }
    // A copy, as Redis decodes a fresh object per read: fetch() deletes cachedAt from what it returns.
    return structuredClone(e.value);
  };
  const redis = {
    packed: {
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) => keys.map((k) => read(k))),
      set: vi.fn(
        async (
          key: RedisKeyTemplateCache,
          value: unknown,
          opts?: { EX?: number; NX?: boolean }
        ) => {
          if (opts?.NX && read(key) !== null) return null;
          store.set(key, {
            value: structuredClone(value),
            expiresAt: Date.now() + (opts?.EX ?? Infinity) * 1000,
          });
          return 'OK';
        }
      ),
    },
    del: vi.fn(async () => 1),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  const noop = () => undefined;
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 300,
    metrics: {
      hit: noop,
      miss: noop,
      revalidate: noop,
      failOpenDegraded: noop,
      failOpenOriginFetch: noop,
      missWouldJoin: noop,
    },
    logFailOpen: noop,
    logRefreshError: noop,
    log: noop,
    clearByPattern: async () => undefined,
  });
  let version = 0;
  // Ids >= 100 have no row. `duringLookup` runs inside the lookup, e.g. to move the clock.
  let duringLookup: () => void = () => undefined;
  const lookupFn = vi.fn(async (ids: number[]) => {
    duringLookup();
    return Object.fromEntries(
      ids.filter((id) => id < 100).map((id) => [id, { id, v: `db-${id}-v${version}` }])
    );
  });
  const cache = createCachedObject<Row>({
    key: KEY,
    idKey: 'id',
    lookupFn,
    ttl: 3600,
    debounceTime,
    staleWhileRevalidate: swr,
  });
  // Ids the fetch path wrote a real value (not the marker) for.
  const valueWrites = () =>
    redis.packed.set.mock.calls
      .filter(([, value]) => !(value as { debounce?: boolean }).debounce)
      .map(([key]) => key);
  const notFoundWrites = () =>
    redis.packed.set.mock.calls
      .filter(([, value]) => (value as { notFound?: boolean }).notFound)
      .map(([key]) => key);
  return {
    cache,
    store,
    read,
    redis,
    lookupFn,
    valueWrites,
    notFoundWrites,
    bumpOrigin: () => version++,
    onLookup: (fn: () => void) => (duringLookup = fn),
  };
}

describe('createCachedObject bust() debounce window (non-SWR)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fetch inside the window goes to origin and is NOT written back', async () => {
    const t = build({ debounceTime: 10 });
    await t.cache.fetch([1]); // warm
    expect(t.valueWrites()).toEqual([keyFor(1)]);

    await t.cache.bust(1);
    vi.setSystemTime(T0 + 3_000); // 3s into a 10s window — well clear of either edge
    t.bumpOrigin();
    const inside = await t.cache.fetch([1]);

    expect(inside).toEqual({ 1: { id: 1, v: 'db-1-v1' } });
    // Only the warm-up write; the in-window lookup must not re-cache.
    expect(t.valueWrites()).toEqual([keyFor(1)]);
    expect(t.read(keyFor(1))).toMatchObject({ id: 1, debounce: true });

    // Every read inside the window keeps going to origin.
    vi.setSystemTime(T0 + 7_000);
    await t.cache.fetch([1]);
    expect(t.lookupFn).toHaveBeenCalledTimes(3);
    expect(t.valueWrites()).toEqual([keyFor(1)]);
  });

  it('a fetch after the window is cached again', async () => {
    const t = build({ debounceTime: 10 });
    await t.cache.bust(1);
    vi.setSystemTime(T0 + 15_000); // 5s past a 10s marker
    await t.cache.fetch([1]);

    expect(t.valueWrites()).toEqual([keyFor(1)]);
    expect(t.read(keyFor(1))).toMatchObject({ id: 1, v: 'db-1-v0' });

    // ...and the next read is a hit.
    await t.cache.fetch([1]);
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
  });

  it('a per-call debounceTime longer than the cache default holds for its full length', async () => {
    const t = build({ debounceTime: 10 });
    await t.cache.bust(1, { debounceTime: 60 });
    vi.setSystemTime(T0 + 30_000); // past the cache default, inside the per-call window
    await t.cache.fetch([1]);

    expect(t.valueWrites()).toEqual([]);
  });

  it('only the busted id is held back; its batch neighbours are cached', async () => {
    const t = build({ debounceTime: 10 });
    await t.cache.bust(1);
    vi.setSystemTime(T0 + 3_000);
    await t.cache.fetch([1, 2]);

    expect(t.valueWrites()).toEqual([keyFor(2)]);
  });

  it('an empty result read inside the window is not negatively cached, even if the marker expires mid-lookup', async () => {
    const t = build({ debounceTime: 10 });
    await t.cache.bust(100); // id 100 has no row
    vi.setSystemTime(T0 + 3_000); // the read lands inside the window...
    // ...and its lookup outlives the marker, so NX against the marker no longer blocks the write.
    t.onLookup(() => vi.setSystemTime(T0 + 15_000));
    await t.cache.fetch([100]);

    // What Redis holds: the marker is gone, so NX would not have stopped a notFound landing.
    expect(t.read(keyFor(100))).toBeNull();
    expect(t.notFoundWrites()).toEqual([]);
  });
});

describe('builder default bust window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a non-SWR cache with no debounceTime holds a bust for 2 s', async () => {
    const t = build(); // no debounceTime: the builder default
    await t.cache.bust(1);
    expect(t.redis.packed.set.mock.calls[0][2]).toEqual({ EX: 2 });

    vi.setSystemTime(T0 + 1_000); // inside the 2 s window
    await t.cache.fetch([1]);
    expect(t.valueWrites()).toEqual([]);

    vi.setSystemTime(T0 + 3_000); // past it
    await t.cache.fetch([1]);
    expect(t.valueWrites()).toEqual([keyFor(1)]);
  });

  it('[invariant] SWR invalidate() still backdates by 10 s by default', async () => {
    const t = build({ swr: true }); // no debounceTime: the builder default
    await t.cache.fetch([1]); // warm at T0
    await t.cache.bust(1); // SWR: bust is invalidate()

    // Backdated so the entry goes stale 10 s from now: cachedAt = now - ttl + 10 s.
    const entry = t.read(keyFor(1)) as { cachedAt: Date };
    expect(new Date(entry.cachedAt).getTime()).toBe(T0 - 3600_000 + 10_000);

    // Still fresh at 5 s (a hit), stale at 11 s (revalidated through the lookup).
    vi.setSystemTime(T0 + 5_000);
    await t.cache.fetch([1]);
    expect(t.lookupFn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 11_000);
    await t.cache.fetch([1]);
    expect(t.lookupFn).toHaveBeenCalledTimes(2);
  });
});

describe('refresh() failure falls back to bust (non-SWR)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a throwing lookup leaves the bust marker, not the old value, and does not throw', async () => {
    const t = build(); // builder default window
    await t.cache.fetch([1]); // warm with v0
    t.bumpOrigin();
    t.onLookup(() => {
      throw new Error('primary down');
    });

    await expect(t.cache.refresh(1)).resolves.toBeUndefined();

    expect(t.redis.packed.set.mock.calls.at(-1)?.[2]).toEqual({ EX: 2 });
    expect(t.read(keyFor(1))).toEqual({ id: 1, debounce: true }); // the old value is gone

    // A read inside the window goes to origin and is not re-cached.
    t.onLookup(() => undefined);
    vi.setSystemTime(T0 + 1_000);
    expect(await t.cache.fetch([1])).toEqual({ 1: { id: 1, v: 'db-1-v1' } });
    expect(t.valueWrites()).toEqual([keyFor(1)]); // only the warm-up
  });
});

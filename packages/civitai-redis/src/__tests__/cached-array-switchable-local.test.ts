import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';
import { letLruClockClear } from './helpers/lru-clock';

/**
 * A `localTtl` FUNCTION makes a cache's per-pod L1 switchable at runtime: asked once per fetch, its
 * answer is that fetch's L1 TTL, and no answer means no L1. Pinned here:
 *  - off makes exactly the Redis calls a cache without `localTtl` makes;
 *  - on, a second read inside the TTL makes no Redis call, and one past it reads Redis again;
 *  - a changed answer empties the L1, so nothing written under one TTL is served under another;
 *  - a bust still writes Redis, and another pod's L1 keeps its copy until its TTL (the accepted
 *    lag), which `bypassLocal` skips;
 *  - `localClone` keeps a caller's nested mutation out of the L1.
 *
 * The redis stub is a Map shared by every cache made from one `build()` — two caches made on one
 * store stand for two pods. The L1 clock is a mocked `performance.now` (see letLruClockClear).
 */

type Row = { id: number; v: string; images: { id: number; level: number }[] };
const KEY = 'packed:caches:test-switchable-l1' as RedisKeyTemplateCache;

let clock = 0;
const advance = async (ms: number) => {
  clock += ms;
  await letLruClockClear();
};

beforeEach(async () => {
  clock = 1_000_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await letLruClockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function build() {
  const store = new Map<string, unknown>();
  const redis = {
    packed: {
      // Copies in and out, as the real codec does, so a caller's mutation cannot reach the store.
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) =>
        keys.map((k) => (store.has(k) ? structuredClone(store.get(k)) : null))
      ),
      set: vi.fn(async (key: RedisKeyTemplateCache, value: unknown, _options?: unknown) => {
        store.set(key, structuredClone(value));
        return 'OK';
      }),
    },
    del: vi.fn(async (keys: RedisKeyTemplateCache | RedisKeyTemplateCache[]) => {
      for (const k of [keys].flat()) store.delete(k);
      return 1;
    }),
    setNxKeepTtlWithEx: vi.fn(async () => true),
  };
  const noop = () => undefined;
  const { createCachedObject } = createCacheBuilders({
    redis: redis as unknown as CacheBuilderDeps['redis'],
    defaultTtl: 3600,
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
  // Pairwise-distinct per id, so a value served for the wrong id cannot pass.
  let version = 0;
  const lookupFn = vi.fn(async (ids: number[]) => {
    version++;
    return Object.fromEntries(
      ids.map((id) => [
        id,
        { id, v: `db-${id}-v${version}`, images: [{ id: id * 10 + 1, level: id * 3 + 1 }] },
      ])
    );
  });
  const make = (options: {
    key?: RedisKeyTemplateCache;
    localTtl?: number | (() => number | undefined);
    localClone?: (x: Row) => Row;
    staleWhileRevalidate?: boolean;
  }) => createCachedObject<Row>({ key: KEY, idKey: 'id', lookupFn, ttl: 3600, ...options });
  return { store, redis, lookupFn, make };
}

// Every Redis read and write a cache made, with its own key prefix dropped so two caches compare.
const calls = (redis: ReturnType<typeof build>['redis'], key: string) => ({
  mGet: redis.packed.mGet.mock.calls.map(([keys]) => keys.map((k) => k.replace(key, ''))),
  set: redis.packed.set.mock.calls.map(([k, value, options]) => [
    k.replace(key, ''),
    { ...(value as Record<string, unknown>), cachedAt: 'x' },
    options,
  ]),
});

describe('createCachedObject — switchable L1 (localTtl function)', () => {
  it('off: makes exactly the Redis calls and returns exactly what a cache without localTtl does', async () => {
    const plain = build();
    const off = build();
    const a = plain.make({});
    const b = off.make({ localTtl: () => undefined });

    const sequence = async (cache: typeof a) => [
      await cache.fetch([1, 2]),
      await cache.fetch([1, 2]),
      await cache.fetch([2, 3]),
      await cache.fetch([1]),
    ];
    const [fromPlain, fromOff] = [await sequence(a), await sequence(b)];

    expect(fromOff).toEqual(fromPlain);
    expect(calls(off.redis, KEY)).toEqual(calls(plain.redis, KEY));
    // Each of the four fetches read Redis: nothing was served from an L1.
    expect(off.redis.packed.mGet).toHaveBeenCalledTimes(4);
    expect(off.lookupFn.mock.calls).toEqual(plain.lookupFn.mock.calls);
  });

  it('a throwing localTtl function reads as off', async () => {
    const t = build();
    const cache = t.make({
      localTtl: () => {
        throw new Error('flag read failed');
      },
    });
    await cache.fetch([1]);
    await cache.fetch([1]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);
  });

  it('on: a second read inside the TTL makes no Redis call; one past the TTL reads Redis again', async () => {
    const t = build();
    const cache = t.make({ localTtl: () => 40 });

    const first = await cache.fetch([7]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1);

    await advance(25_000); // mid-window
    expect(await cache.fetch([7])).toEqual(first);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1);

    await advance(14_000); // 39s: still inside the 40s window
    expect(await cache.fetch([7])).toEqual(first);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1);

    await advance(2_000); // 41s: past it
    expect(await cache.fetch([7])).toEqual(first); // Redis still holds the same entry
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);
    expect(t.redis.packed.mGet.mock.calls[1][0]).toEqual([`${KEY}:7`]);
  });

  it('switching off empties the L1 at once, and switching back on does not resurrect it', async () => {
    const t = build();
    let ttl: number | undefined = 300;
    const cache = t.make({ localTtl: () => ttl });

    await cache.fetch([5]);
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1);

    ttl = undefined;
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);

    ttl = 300;
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(3);
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(3);
  });

  it('an entry written under a long TTL is not served once the TTL is shortened', async () => {
    const t = build();
    let ttl = 300;
    const cache = t.make({ localTtl: () => ttl });

    await cache.fetch([5]);
    await advance(60_000);
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1); // inside 300s

    ttl = 30;
    await cache.fetch([5]); // the change emptied the L1, though the 300s entry had 240s left
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);
    await advance(29_000);
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);
    await advance(2_000);
    await cache.fetch([5]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(3);
  });

  // A fetch reads the TTL when it starts and fills the L1 when it ends; a change in between empties
  // the L1, and the late fetch must not refill it under the TTL it started with.
  it.each([
    ['the TTL changes mid-fetch: a fetch begun before it does not refill the emptied L1', 30, 2],
    ['control, no change: the same late fetch does fill the L1', 60, 1],
  ] as const)('%s', async (_name, ttlAfter, redisReadsOfId1) => {
    const t = build();
    let ttl = 60;
    const cache = t.make({ localTtl: () => ttl });

    // The first lookup (fetch A, id 1) waits until released.
    let release!: () => void;
    let entered!: () => void;
    const inLookup = new Promise<void>((r) => (entered = r));
    t.lookupFn.mockImplementationOnce(async (ids: number[]) => {
      entered();
      await new Promise<void>((r) => (release = r));
      return Object.fromEntries(ids.map((id) => [id, { id, v: `slow-${id}`, images: [] }]));
    });

    const slow = cache.fetch([1]); // starts under 60s
    await inLookup;
    ttl = ttlAfter;
    await cache.fetch([2]); // the first fetch to see the change empties the L1
    release();
    expect((await slow)[1].v).toBe('slow-1');

    // With the change id 1 is not in the L1, so this read goes to Redis; without it, it does not.
    expect((await cache.fetch([1]))[1].v).toBe('slow-1');
    const readsOfId1 = t.redis.packed.mGet.mock.calls.filter(([keys]) =>
      keys.includes(`${KEY}:1` as RedisKeyTemplateCache)
    ).length;
    expect(readsOfId1).toBe(redisReadsOfId1);
  });
});

describe('createCachedObject — switchable L1 and busts', () => {
  it('a non-SWR bust still writes its Redis marker, and this pod reads Redis next', async () => {
    const t = build();
    const cache = t.make({ localTtl: () => 60, staleWhileRevalidate: false });

    await cache.fetch([3]);
    t.redis.packed.set.mockClear();
    await cache.bust(3);

    expect(t.redis.packed.set).toHaveBeenCalledWith(
      `${KEY}:3`,
      { id: 3, debounce: true },
      { EX: 2 },
      expect.anything()
    );
    await cache.fetch([3]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(2);
    expect(t.lookupFn).toHaveBeenCalledTimes(2); // the marker sent it to the origin
  });

  it('an SWR bust still rewrites the Redis entry, and this pod reads Redis next', async () => {
    const t = build();
    const cache = t.make({ localTtl: () => 60 });

    await cache.fetch([3]);
    t.redis.packed.set.mockClear();
    await cache.bust(3);

    expect(t.redis.packed.set).toHaveBeenCalledTimes(1);
    expect(t.redis.packed.set.mock.calls[0][0]).toBe(`${KEY}:3`);
    await cache.fetch([3]);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(3); // fetch, bust's read, fetch
  });

  it('another pod keeps its L1 copy after a bust until its TTL; bypassLocal reads Redis', async () => {
    const t = build();
    const podA = t.make({ localTtl: () => 60, staleWhileRevalidate: false });
    const podB = t.make({ localTtl: () => 60, staleWhileRevalidate: false });

    const before = await podB.fetch([9]);
    await podA.refresh(9); // a write on pod A re-reads the origin into Redis
    const after = (await podA.fetch([9]))[9];
    expect(after.v).not.toBe(before[9].v);

    expect((await podB.fetch([9]))[9].v).toBe(before[9].v); // the accepted cross-pod lag
    expect((await podB.fetch([9], { bypassLocal: true }))[9].v).toBe(after.v);
    // ...and that read refreshed pod B's L1: the next read is served from it.
    const readsAfterBypass = t.redis.packed.mGet.mock.calls.length;
    expect((await podB.fetch([9]))[9].v).toBe(after.v);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(readsAfterBypass);

    // Past the TTL that copy has expired, so the next read goes to Redis.
    await advance(61_000);
    expect((await podB.fetch([9]))[9].v).toBe(after.v);
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(readsAfterBypass + 1);
  });
});

describe('createCachedObject — localClone', () => {
  it("keeps a caller's nested mutation out of the L1", async () => {
    const t = build();
    const cache = t.make({
      localTtl: () => 60,
      localClone: (x) => ({ ...x, images: x.images.map((i) => ({ ...i })) }),
    });

    const first = (await cache.fetch([4]))[4];
    first.images[0].level = 999;
    first.images.push({ id: 1, level: 1 });

    const second = (await cache.fetch([4]))[4];
    expect(t.redis.packed.mGet).toHaveBeenCalledTimes(1);
    expect(second.images).toEqual([{ id: 41, level: 13 }]);

    second.images[0].level = 777;
    expect((await cache.fetch([4]))[4].images).toEqual([{ id: 41, level: 13 }]);
  });
});

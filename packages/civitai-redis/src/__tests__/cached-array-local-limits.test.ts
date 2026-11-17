import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCacheBuilders, type CacheBuilderDeps } from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';
import { letLruClockClear } from './helpers/lru-clock';

/**
 * `localLimits(ttl)` gives a switchable L1 a different entry/byte cap per TTL tier, so one switch can
 * change how MUCH the L1 holds as well as for how long. Pinned here:
 *  - without it, the L1 keeps `localMax` whatever the TTL (the control: the small cap evicts);
 *  - with it, a tier's caps are the ones in force: the larger tier holds what the smaller evicts;
 *  - switching back rebuilds the L1 empty at the smaller caps again;
 *  - the byte cap of a tier is applied, not only its entry cap;
 *  - a static `localTtl` gets `localLimits(localTtl)` at construction.
 *
 * Every read here is inside the TTL, so a Redis read means the id was EVICTED, not expired. The L1
 * clock is a mocked `performance.now` (see letLruClockClear), held still.
 */

type Row = { id: number; v: string };
const KEY = 'packed:caches:test-local-limits' as RedisKeyTemplateCache;

beforeEach(async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => 1_000_000);
  await letLruClockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function build() {
  const store = new Map<string, unknown>();
  const redis = {
    packed: {
      mGet: vi.fn(async (keys: RedisKeyTemplateCache[]) =>
        keys.map((k) => (store.has(k) ? structuredClone(store.get(k)) : null))
      ),
      set: vi.fn(async (key: RedisKeyTemplateCache, value: unknown) => {
        store.set(key, structuredClone(value));
        return 'OK';
      }),
    },
    del: vi.fn(async () => 1),
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
  const lookupFn = vi.fn(async (ids: number[]) =>
    Object.fromEntries(ids.map((id) => [id, { id, v: `db-${id}` }]))
  );
  // Redis reads that asked for this id.
  const readsOf = (id: number) =>
    redis.packed.mGet.mock.calls.filter(([keys]) => keys.includes(`${KEY}:${id}` as never)).length;
  const make = (options: {
    localTtl: number | (() => number | undefined);
    localMax?: number;
    localMaxBytes?: number;
    localLimits?: (ttl: number) => { max: number; maxBytes?: number };
  }) => createCachedObject<Row>({ key: KEY, idKey: 'id', lookupFn, ttl: 3600, ...options });
  return { redis, readsOf, make };
}

// One fetch per id, in order, so the LRU's recency order is the id order.
async function fillOneByOne(cache: { fetch: (ids: number[]) => Promise<unknown> }, ids: number[]) {
  for (const id of ids) await cache.fetch([id]);
}

const tiers = (ttl: number) => (ttl === 120 ? { max: 4 } : { max: 2 });

describe('createCachedObject — localLimits (per-TTL L1 caps)', () => {
  it('control: without localLimits the L1 keeps localMax at any TTL, so a third id evicts the first', async () => {
    const t = build();
    const cache = t.make({ localTtl: () => 120, localMax: 2 });
    await fillOneByOne(cache, [1, 2, 3]);
    expect(t.readsOf(1)).toBe(1);
    await cache.fetch([1]);
    expect(t.readsOf(1)).toBe(2); // evicted, read again
  });

  it('the larger tier holds what the smaller one evicts', async () => {
    const t = build();
    let ttl = 60;
    const cache = t.make({ localTtl: () => ttl, localMax: 2, localLimits: tiers });

    // Small tier (60s → 2 entries): the first of three is evicted.
    await fillOneByOne(cache, [1, 2, 3]);
    await cache.fetch([1]);
    expect(t.readsOf(1)).toBe(2);

    // Large tier (120s → 4 entries): four ids all stay.
    ttl = 120;
    await fillOneByOne(cache, [11, 12, 13, 14]);
    await cache.fetch([11, 12, 13, 14]);
    expect([11, 12, 13, 14].map(t.readsOf)).toEqual([1, 1, 1, 1]);

    // Back to the small tier: emptied (14 is read again) and capped at 2 again.
    ttl = 60;
    await cache.fetch([14]);
    expect(t.readsOf(14)).toBe(2);
    await fillOneByOne(cache, [21, 22, 23]);
    await cache.fetch([21]);
    expect(t.readsOf(21)).toBe(2);
  });

  it("applies a tier's byte cap, not only its entry cap", async () => {
    const t = build();
    // Each row sizes at 2 x its JSON length + 64 (106 bytes here), so 300 bytes holds two.
    const cache = t.make({
      localTtl: () => 60,
      localLimits: () => ({ max: 100, maxBytes: 300 }),
    });
    await fillOneByOne(cache, [31, 32, 33]);
    await cache.fetch([32, 33]);
    expect([32, 33].map(t.readsOf)).toEqual([1, 1]);
    await cache.fetch([31]);
    expect(t.readsOf(31)).toBe(2);
  });

  it('a static localTtl takes localLimits(localTtl) at construction', async () => {
    const t = build();
    const cache = t.make({ localTtl: 120, localMax: 2, localLimits: tiers });
    await fillOneByOne(cache, [41, 42, 43, 44]);
    await cache.fetch([41, 42, 43, 44]);
    expect([41, 42, 43, 44].map(t.readsOf)).toEqual([1, 1, 1, 1]);
  });
});

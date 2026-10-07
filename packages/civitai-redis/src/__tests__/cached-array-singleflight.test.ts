import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-process coalescing of createCachedArray / createCachedObject miss-fill.
 *
 * Without it, N concurrent fetches that miss Redis for the same id each run lookupFn for it AND
 * each compress + SET the identical value. When a cache's Redis memory is at its cap, evictions
 * turn hot ids into misses all at once, and that duplicated refill is what bursts.
 *
 * Same harness as cached-array-compress.test.ts: only the TRANSPORT is faked (an in-memory server
 * of raw Buffers behind `redis`'s client factory); `createCacheRedis`, `client.packed.*`, the codec
 * and `createCacheBuilders` are the real modules. Every server-side SET is recorded in `setLog`, so
 * "exactly one SET for id X" is counted at the transport, not inferred from a mock of packed.set.
 */

vi.hoisted(() => {
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_SYS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_CLUSTER = 'false';
});

const { store, setLog, getLog } = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  setLog: [] as { key: string; NX: boolean }[],
  getLog: [] as string[],
}));

vi.mock('redis', () => {
  const toBuffer = (v: unknown): Buffer =>
    Buffer.isBuffer(v) ? v : Buffer.from(v as string, 'binary');

  const makeClient = (bufferMode = false): Record<string, unknown> => {
    const self: Record<string, any> = {
      connect: () => Promise.resolve(self),
      on: () => self,
      withTypeMapping: () => makeClient(true),
      get: async (key: string) => {
        getLog.push(key);
        const v = store.get(key);
        if (v === undefined) return null;
        return bufferMode ? v : v.toString('binary');
      },
      set: async (key: string, value: unknown, options?: { NX?: boolean; XX?: boolean }) => {
        setLog.push({ key, NX: !!options?.NX });
        const exists = store.has(key);
        if (options?.NX && exists) return null;
        if (options?.XX && !exists) return null;
        store.set(key, toBuffer(value));
        return 'OK';
      },
      del: async (key: string) => (store.delete(key) ? 1 : 0),
      unlink: async (key: string) => (store.delete(key) ? 1 : 0),
      eval: async (_script: string, opts: { keys: string[] }) => {
        const key = opts.keys[0];
        if (store.has(key)) return 0;
        store.set(key, Buffer.from('1'));
        return 1;
      },
      scanIterator: async function* () {
        /* unused */
      },
    };
    return self;
  };

  return {
    createClient: () => makeClient(false),
    createCluster: () => makeClient(false),
    createSentinel: () => makeClient(false),
    RESP_TYPES: { BLOB_STRING: 36 },
  };
});

import { createCacheBuilders, type CachedLookupOptions } from '../cached-array';
import { createCacheRedis } from '../client';
import type { RedisKeyTemplateCache } from '../client';

const redis = createCacheRedis();

type Row = { id: number; v: string; tags?: string[] };

const KEY = 'packed:caches:test-singleflight' as RedisKeyTemplateCache;

type Lookup = (ids: number[], fromWrite?: boolean) => Promise<Record<string, Row>>;

function buildCache(lookupFn: Lookup, overrides: Partial<CachedLookupOptions<Row>> = {}) {
  const noopMetrics = {
    hit: () => undefined,
    miss: () => undefined,
    revalidate: () => undefined,
    failOpenDegraded: () => undefined,
    failOpenOriginFetch: () => undefined,
  };
  const { createCachedObject } = createCacheBuilders({
    redis,
    defaultTtl: 300,
    metrics: noopMetrics,
    logFailOpen: () => undefined,
    logRefreshError: () => undefined,
    log: () => undefined,
    clearByPattern: async () => undefined,
  });
  return createCachedObject<Row>({
    key: KEY,
    idKey: 'id',
    lookupFn,
    ttl: 3600,
    compress: true,
    ...overrides,
  });
}

/** A promise you resolve/reject from outside, so a test controls exactly when a lookup settles. */
function gate() {
  let open!: () => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    open = res;
    fail = rej;
  });
  return { promise, open, fail };
}

/**
 * Wait until the transport has served `n` GETs, then drain the queue so every fetch that issued
 * one has run past its miss-fill decision (the code after a GET reply is promise continuations
 * only) and is parked on a gated lookup. Anchoring on an observed GET count, not a bare tick,
 * keeps "B decided while A's lookup was in flight" deterministic.
 */
async function untilGets(n: number) {
  await vi.waitFor(() => expect(getLog.length).toBeGreaterThanOrEqual(n));
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** Value SETs for one id (lock keys and other ids excluded). */
const setsFor = (id: number) => setLog.filter((s) => s.key === `${KEY}:${id}`);

/** Every id passed to lookupFn across all calls, as a sorted list (duplicates kept). */
const lookedUpIds = (fn: ReturnType<typeof vi.fn>) =>
  (fn.mock.calls as [number[], boolean?][]).flatMap(([ids]) => ids).sort((a, b) => a - b);

beforeEach(() => {
  store.clear();
  setLog.length = 0;
  getLog.length = 0;
});

describe('createCachedObject miss-fill — per-process single-flight', () => {
  // REGRESSION: red at origin/main (lookupFn called twice, two SETs for id 1).
  it('two concurrent cold fetches of one id issue ONE lookup and ONE set', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([1]);
    const b = cache.fetch([1]);
    await untilGets(2);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);

    expect(lookupFn, 'lookupFn calls for one id fetched concurrently twice').toHaveBeenCalledTimes(
      1
    );
    expect(setsFor(1), 'value SETs for id 1').toHaveLength(1);
    expect(ra).toEqual({ '1': { id: 1, v: 'row-1' } });
    expect(rb).toEqual(ra);
    // Each caller owns its object: the shared lookup record is cloned per fetch.
    expect(rb['1']).not.toBe(ra['1']);

    // And the value that was written is the one a later read decodes.
    const again = await cache.fetch([1]);
    expect(again).toEqual(ra);
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  // REGRESSION: red at origin/main (id 2 looked up twice).
  it('overlapping batches look up each id once and still return every id', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([1, 2]);
    const b = cache.fetch([2, 3]);
    await untilGets(4);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);

    expect(lookedUpIds(lookupFn), 'ids passed to lookupFn across both fetches').toEqual([1, 2, 3]);
    expect(lookupFn.mock.calls.map(([ids]) => ids)).toEqual([[1, 2], [3]]);
    expect(ra).toEqual({ '1': { id: 1, v: 'row-1' }, '2': { id: 2, v: 'row-2' } });
    expect(rb).toEqual({ '2': { id: 2, v: 'row-2' }, '3': { id: 3, v: 'row-3' } });
    expect(setsFor(1)).toHaveLength(1);
    expect(setsFor(2)).toHaveLength(1);
    expect(setsFor(3)).toHaveLength(1);
  });

  // REGRESSION: red at origin/main (two NX SETs, each compressed first).
  it('a joined not-found id writes ONE negative marker', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async () => {
      await g.promise;
      return {};
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([9]);
    const b = cache.fetch([9]);
    await untilGets(2);
    g.open();
    expect(await a).toEqual({});
    expect(await b).toEqual({});
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(setsFor(9), 'notFound marker SETs for id 9').toEqual([{ key: `${KEY}:9`, NX: true }]);
  });

  it('a failed lookup rejects exactly its waiters, and the next fetch retries cleanly', async () => {
    const g = gate();
    let calls = 0;
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      calls++;
      if (calls === 1) {
        await g.promise; // rejected below
      }
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([5]);
    const b = cache.fetch([5]);
    await untilGets(2);
    g.fail(new Error('db down'));
    await expect(a).rejects.toThrow('db down');
    await expect(b, 'the fetch that joined the failed lookup').rejects.toThrow('db down');
    expect(lookupFn).toHaveBeenCalledTimes(1);

    // The failed entry must be gone: a later fetch originates a fresh lookup and succeeds.
    await expect(cache.fetch([5]), 'fetch after the failed lookup settled').resolves.toEqual({
      '5': { id: 5, v: 'row-5' },
    });
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  // INVARIANT GUARD (green at origin/main too): a SUCCESSFUL lookup is also dropped on settle, so
  // once Redis loses the key (eviction) the next miss re-reads the origin instead of being handed
  // the old in-process result forever.
  it('a settled lookup is never reused after the key is evicted', async () => {
    let version = 1;
    const lookupFn = vi.fn<Lookup>(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { id, v: `v${version}` }]))
    );
    const cache = buildCache(lookupFn);

    expect(await cache.fetch([3])).toEqual({ '3': { id: 3, v: 'v1' } });
    store.delete(`${KEY}:3`); // LRU eviction
    version = 2;
    expect(await cache.fetch([3]), 'fetch after eviction').toEqual({ '3': { id: 3, v: 'v2' } });
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  // INVARIANT GUARD (green at origin/main too — main never shares a lookup). Pins that coalescing
  // did not open a pre-write read: a refresh() in this process detaches the in-flight read lookup.
  it('a fetch that starts after refresh() began does not join the pre-write read lookup', async () => {
    let dbValue = 'old';
    const readGate = gate();
    const writeGate = gate();
    const lookupFn = vi.fn<Lookup>(async (ids, fromWrite) => {
      const snapshot = dbValue; // the row as this query sees it
      await (fromWrite ? writeGate.promise : readGate.promise);
      return Object.fromEntries(ids.map((id) => [id, { id, v: snapshot }]));
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([4]); // read-path lookup in flight, saw 'old'
    await untilGets(1);

    dbValue = 'new'; // the mutation commits
    const refreshing = cache.refresh(4); // fromWrite lookup, not yet written to redis
    const b = cache.fetch([4]); // misses redis; must NOT join `a`'s lookup
    await untilGets(2);

    readGate.open();
    expect(await a).toEqual({ '4': { id: 4, v: 'old' } }); // started before the write: fine
    expect(await b, 'fetch started after refresh() began').toEqual({ '4': { id: 4, v: 'new' } });

    writeGate.open();
    await refreshing;
    expect(lookupFn).toHaveBeenCalledWith([4], true); // refresh did its own dbWrite lookup
    expect(lookupFn).toHaveBeenCalledTimes(3);
    expect(await cache.fetch([4])).toEqual({ '4': { id: 4, v: 'new' } });
  });

  // REGRESSION for the shared-record hazard coalescing introduces: appendFn mutates IN PLACE, so
  // a record shared between the originator and a joiner must not be decorated twice or leak a
  // decoration into what is written to redis.
  it('appendFn mutating in place cannot leak across joined fetches or into redis', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const appendFn = async (rows: Set<Row>) => {
      for (const r of rows) r.tags = [...(r.tags ?? []), 'appended'];
    };
    const cache = buildCache(lookupFn, { appendFn });

    const a = cache.fetch([6]);
    const b = cache.fetch([6]);
    await untilGets(2);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra['6'].tags).toEqual(['appended']);
    expect(rb['6'].tags, 'joined fetch decorated exactly once').toEqual(['appended']);

    // Served from redis, then decorated once: the stored value carries no decoration.
    const again = await cache.fetch([6]);
    expect(again['6'].tags).toEqual(['appended']);
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  // INVARIANT GUARD: a debounced id (bust landed within debounceTime) never joins an in-flight
  // lookup that may predate the bust.
  it('a debounced id originates its own lookup instead of joining', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn, { staleWhileRevalidate: false });

    const a = cache.fetch([8]); // read lookup in flight
    await untilGets(1);
    // Simulate a bust from ANOTHER process: the debounce marker appears in redis, but this
    // process's in-flight entry was not detached.
    const other = buildCache(lookupFn, { staleWhileRevalidate: false });
    await other.bust(8);
    const b = cache.fetch([8]);
    await untilGets(2);
    g.open();
    await Promise.all([a, b]);
    expect(lookedUpIds(lookupFn)).toEqual([8, 8]);
  });
});

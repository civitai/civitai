import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-process coalescing of createCachedArray / createCachedObject miss-fill.
 *
 * "red before coalescing" / "green before coalescing too" in the labels below describe the source
 * as it was before the in-flight map existed.
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

const { store, setLog, getLog, setHold } = vi.hoisted(() => ({
  store: new Map<string, Buffer>(),
  setLog: [] as { key: string; NX: boolean }[],
  getLog: [] as string[],
  // While `gate` is set, every SET is logged on arrival but not applied until the gate opens.
  setHold: { gate: null as Promise<void> | null },
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
        if (setHold.gate) await setHold.gate;
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
import { createCacheRedis, REDIS_KEYS } from '../client';
import type { RedisKeyTemplateCache } from '../client';

const redis = createCacheRedis();

type Row = { id: number; v: string; tags?: string[]; nested?: { notes: string[] } };

const KEY = 'packed:caches:test-singleflight' as RedisKeyTemplateCache;

type Lookup = (ids: number[], fromWrite?: boolean) => Promise<Record<string, Row>>;

function makeBuilders(miss: (name: string, type: string, count: number) => void = () => undefined) {
  return createCacheBuilders({
    redis,
    defaultTtl: 300,
    metrics: {
      hit: () => undefined,
      miss,
      revalidate: () => undefined,
      failOpenDegraded: () => undefined,
      failOpenOriginFetch: () => undefined,
    },
    logFailOpen: () => undefined,
    logRefreshError: () => undefined,
    log: () => undefined,
    clearByPattern: async () => undefined,
  });
}

function buildCache(
  lookupFn: Lookup,
  overrides: Partial<CachedLookupOptions<Row>> = {},
  builders = makeBuilders()
) {
  return builders.createCachedObject<Row>({
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
 * one has run past its miss-fill decision and is parked on a gated lookup. Anchoring on an
 * observed GET count, not a bare tick, keeps "B decided while A's lookup was in flight"
 * deterministic — for a GET that returns NULL, after which there are only promise continuations.
 * A GET that returns a compressed VALUE is decoded on the libuv threadpool, which a drain does not
 * bound; such a test must wait on a state its outcome produces instead.
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
  // Regression: red before coalescing (lookupFn called twice, two SETs for id 1).
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

  // Regression: red before coalescing (id 2 looked up twice).
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

  // Regression: red before coalescing (two NX SETs, each compressed first).
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

  // Invariant guard (green before coalescing too): a SUCCESSFUL lookup is also dropped, so
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

  // Invariant guard (green before coalescing too — nothing was shared). Pins that coalescing did not
  // open a pre-write read: a refresh() in this process detaches the in-flight read lookup.
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

  // Invariant guard: appendFn mutates records in place, so a record shared by the originator and
  // its joiners must be cloned per fetch and must not carry any fetch's decoration into redis.
  // (Before coalescing nothing was shared; that tree fails this test only on the lookup count.)
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

    // One originator and TWO joiners: with one joiner, skipping the clone for joiners only would
    // still pass, since the originator's copy is already distinct.
    const a = cache.fetch([6]);
    const b = cache.fetch([6]);
    const c = cache.fetch([6]);
    await untilGets(3);
    g.open();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(ra['6'].tags).toEqual(['appended']);
    expect(rb['6'].tags, 'first joiner decorated exactly once').toEqual(['appended']);
    expect(rc['6'].tags, 'second joiner decorated exactly once').toEqual(['appended']);
    expect(rb['6']).not.toBe(rc['6']);

    // Served from redis, then decorated once: the stored value carries no decoration.
    const again = await cache.fetch([6]);
    expect(again['6'].tags).toEqual(['appended']);
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  // Regression for a hazard coalescing introduces: the per-fetch clone is shallow, so a joiner's
  // appendFn that mutates a NESTED object must not reach the value its originator writes. The
  // originator here also waits on a slower joined lookup, so a write built after that wait would
  // pack the joiner's decoration.
  it("a joiner's nested appendFn mutation never reaches the originator's redis write", async () => {
    const slow = gate();
    const fast = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await (ids.includes(2) ? slow.promise : fast.promise);
      return Object.fromEntries(
        ids.map((id) => [id, { id, v: `row-${id}`, nested: { notes: [] } }])
      );
    });
    const appendFn = async (rows: Set<Row>) => {
      for (const r of rows) r.nested?.notes.push('decorated');
    };
    const cache = buildCache(lookupFn, { appendFn });

    const w = cache.fetch([2]); // slow lookup for id 2
    await untilGets(1);
    const x = cache.fetch([1, 2]); // originates id 1, joins id 2
    await untilGets(3);
    const y = cache.fetch([1]); // joins id 1
    await untilGets(4);
    fast.open();
    // y's appendFn has now run on the nested object x's record shares. x's result shares it too
    // (clones are shallow); this test pins only that nothing decorated reaches redis.
    await y;
    slow.open();
    await Promise.all([w, x]);

    const plain = buildCache(lookupFn); // same key, no appendFn: reads the stored bytes as-is
    expect((await plain.fetch([1]))['1'], 'stored value for id 1').toEqual({
      id: 1,
      v: 'row-1',
      nested: { notes: [] },
    });
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  // Invariant guard: a debounced id (a bust landed recently) never joins an in-flight lookup that
  // may predate the bust.
  it('a debounced id originates its own lookup instead of joining', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn, { staleWhileRevalidate: false });

    const a = cache.fetch([8]); // read lookup in flight
    await untilGets(1);
    // A bust from ANOTHER process: the debounce marker appears in redis, but this process's
    // in-flight entry is not detached.
    const other = buildCache(lookupFn, { staleWhileRevalidate: false });
    await other.bust(8);
    const b = cache.fetch([8]);
    // b reads (and brotli-decodes) the marker, so wait on the outcome itself: a second lookup.
    // Joining instead never produces it, and this times out red rather than passing.
    await vi.waitFor(() => expect(lookupFn, 'lookups for id 8').toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    g.open();
    await Promise.all([a, b]);
    expect(lookedUpIds(lookupFn)).toEqual([8, 8]);
  });

  // Invariant guard: bust/invalidate detach in-flight lookups too, not just refresh. invalidate on
  // an absent key writes nothing, so a fetch after it would otherwise join the older lookup.
  it('a fetch that starts after invalidate() does not join the older lookup', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn); // SWR (default) ⇒ bust is invalidate

    const a = cache.fetch([12]);
    await untilGets(1);
    await cache.bust(12); // invalidate: mGet sees no entry, rewrites nothing
    const b = cache.fetch([12]);
    await vi.waitFor(() => expect(lookupFn, 'lookups for id 12').toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    g.open();
    await Promise.all([a, b]);
  });

  // Invariant guard: one builder, two caches, same id in flight in both — each gets its own row.
  it('two caches from one builder never share an in-flight lookup', async () => {
    const g = gate();
    const builders = makeBuilders();
    const lookupA = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `A-${id}` }]));
    });
    const lookupB = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `B-${id}` }]));
    });
    const cacheA = buildCache(lookupA, {}, builders);
    const cacheB = buildCache(
      lookupB,
      { key: 'packed:caches:test-singleflight-b' as RedisKeyTemplateCache },
      builders
    );

    const a = cacheA.fetch([7]);
    await untilGets(1);
    const b = cacheB.fetch([7]);
    await untilGets(2);
    g.open();
    expect(await a).toEqual({ '7': { id: 7, v: 'A-7' } });
    expect(await b, 'cache B, same id').toEqual({ '7': { id: 7, v: 'B-7' } });
    expect(lookupA).toHaveBeenCalledTimes(1);
    expect(lookupB).toHaveBeenCalledTimes(1);
  });

  // Regression: red before coalescing (id 10 looked up and SET twice). The entry must outlive the
  // lookup until the originator's write has landed, or a GET in between redoes both.
  it('a fetch that misses while the originator is still writing joins instead of re-filling', async () => {
    const lookupFn = vi.fn<Lookup>(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]))
    );
    const cache = buildCache(lookupFn);
    const hold = gate();
    setHold.gate = hold.promise;
    try {
      const a = cache.fetch([10]);
      await vi.waitFor(() => expect(setsFor(10)).toHaveLength(1)); // a's SET is in flight
      const b = cache.fetch([10]); // GET misses: the SET has not been applied
      await untilGets(2);
      hold.open();
      const [ra, rb] = await Promise.all([a, b]);
      expect(rb).toEqual(ra);
      expect(lookupFn, 'lookups for id 10').toHaveBeenCalledTimes(1);
      expect(setsFor(10), 'SETs for id 10').toHaveLength(1);
    } finally {
      setHold.gate = null;
    }
  });

  // Invariant guard: a fetch that joined a lookup which then FAILED rejects, but the ids it looked
  // up itself are still written.
  it("a failed joined lookup still lets the joiner's own ids be written", async () => {
    const bad = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      if (ids.includes(20)) await bad.promise; // rejected below
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);

    const a = cache.fetch([20]);
    await untilGets(1);
    const b = cache.fetch([20, 21]); // joins 20, originates 21
    await untilGets(3);
    bad.fail(new Error('db down'));
    await expect(a).rejects.toThrow('db down');
    await expect(b, 'fetch that joined the failed lookup').rejects.toThrow('db down');
    expect(setsFor(21), "b's own id was written").toHaveLength(1);
    expect(await cache.fetch([21])).toEqual({ '21': { id: 21, v: 'row-21' } });
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  // Invariant guard (green before coalescing too): EVERY id of a multi-id lookup is released, not
  // just the first.
  it('all ids of a settled multi-id lookup are re-read after eviction', async () => {
    const lookupFn = vi.fn<Lookup>(async (ids) =>
      Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]))
    );
    const cache = buildCache(lookupFn);
    await cache.fetch([60, 61, 62]);
    for (const id of [60, 61, 62]) store.delete(`${KEY}:${id}`); // LRU eviction
    await cache.fetch([60, 61, 62]);
    expect(lookedUpIds(lookupFn), 'ids looked up across both fetches').toEqual([
      60, 60, 61, 61, 62, 62,
    ]);
  });

  // Invariant guard (green before coalescing too): past IN_FLIGHT_JOIN_MAX_MS a fetch originates
  // its own lookup instead of joining a stuck one.
  it('a stuck lookup is not joined forever', async () => {
    const never = new Promise<void>(() => undefined);
    let calls = 0;
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      if (++calls === 1) await never;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      void cache.fetch([30]); // hangs forever
      await untilGets(1);
      vi.setSystemTime(Date.now() + 10_001);
      // Raced against a real timer so joining the stuck lookup fails on this assertion, not on the
      // test timeout.
      const after = await Promise.race([
        cache.fetch([30]),
        new Promise((r) => setTimeout(() => r('still waiting on the stuck lookup'), 1000)),
      ]);
      expect(after, 'fetch after the stuck lookup aged out').toEqual({
        '30': { id: 30, v: 'row-30' },
      });
      expect(lookupFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Guard on the cleanup: an aged-out lookup that finally settles must not remove the newer entry.
  it('an older lookup settling does not remove a newer entry for the same id', async () => {
    const first = gate();
    const second = gate();
    let calls = 0;
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await (++calls === 1 ? first.promise : second.promise);
      return {}; // not found, and cacheNotFound=false below: nothing is written to redis
    });
    const cache = buildCache(lookupFn, { cacheNotFound: false });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const a = cache.fetch([31]);
      await untilGets(1);
      vi.setSystemTime(Date.now() + 10_001);
      const b = cache.fetch([31]); // originates a newer entry
      await untilGets(2);
      first.open();
      await a; // a's cleanup runs; it must leave b's entry alone
      const c = cache.fetch([31]); // must join b
      await untilGets(3);
      second.open();
      await Promise.all([b, c]);
      expect(lookupFn, 'lookups for id 31').toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** A debounce marker INSIDE its window, as a bust that stamps cachedAt would write it. */
  const writeFreshDebounceMarker = (id: number) =>
    redis.packed.set(
      `${KEY}:${id}` as RedisKeyTemplateCache,
      { id, debounce: true, cachedAt: new Date() },
      { EX: 10 },
      { compress: true }
    );

  // Guard: a lookup for ids that are all inside a debounce window registers nothing, and its
  // rejection must still be handled (an unhandled rejection kills the process).
  it('a failed lookup of only debounce-window ids rejects cleanly', async () => {
    const lookupFn = vi.fn<Lookup>(async () => {
      throw new Error('db down');
    });
    const cache = buildCache(lookupFn, { staleWhileRevalidate: false });
    await writeFreshDebounceMarker(50);
    await expect(cache.fetch([50])).rejects.toThrow('db down');
  });

  // Guard: a debounce-window id is not registered, so nobody joins a lookup whose result will not
  // be cached.
  it('a lookup for a debounce-window id is not joined', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn, { staleWhileRevalidate: false });
    await writeFreshDebounceMarker(51);
    const a = cache.fetch([51]);
    await vi.waitFor(() => expect(lookupFn).toHaveBeenCalledTimes(1), { timeout: 3000 });
    store.delete(`${KEY}:51`); // marker expired: b misses outright
    const b = cache.fetch([51]);
    await vi.waitFor(() => expect(lookupFn, 'lookups for id 51').toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    g.open();
    await Promise.all([a, b]);
  });

  // Guard on the lower side of the age cap: a lookup just under IN_FLIGHT_JOIN_MAX_MS is joined.
  it('a lookup just under the age cap is still joined', async () => {
    const g = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const a = cache.fetch([52]);
      await untilGets(1);
      // 100ms short of the cap: the faked Date still advances with real time between the two
      // reads, so landing exactly on the boundary would be flaky.
      vi.setSystemTime(Date.now() + 9_900);
      const b = cache.fetch([52]);
      await untilGets(2);
      g.open();
      await Promise.all([a, b]);
      expect(lookupFn, 'lookups for id 52').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Guard: a fetch whose joined lookup fails still releases its own revalidate locks before it
  // rejects, so the stale id it won is not left locked for the lock's TTL.
  it('a failed joined lookup still releases the joiner’s revalidate locks', async () => {
    const bad = gate();
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      if (ids.includes(53)) await bad.promise; // rejected below
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn);
    // id 54 is stale (cachedAt past the 3600s ttl) so the fetch takes its revalidate lock.
    await redis.packed.set(
      `${KEY}:54` as RedisKeyTemplateCache,
      { id: 54, v: 'stale', cachedAt: new Date(Date.now() - 3601 * 1000) },
      { EX: 7200 },
      { compress: true }
    );
    const lockKey = `${REDIS_KEYS.CACHE_LOCKS}:${KEY}:54`;

    const a = cache.fetch([53]);
    await untilGets(1);
    const b = cache.fetch([53, 54]); // joins 53, wins the lock on 54
    await vi.waitFor(() => expect(store.has(lockKey), 'lock taken').toBe(true), { timeout: 3000 });
    bad.fail(new Error('db down'));
    await expect(a).rejects.toThrow('db down');
    await expect(b).rejects.toThrow('db down');
    expect(store.has(lockKey), 'revalidate lock released').toBe(false);
  });

  it('reports joined misses under their own cache_type, keeping the total', async () => {
    const g = gate();
    const misses: [string, number][] = [];
    const builders = makeBuilders((_name, type, count) => misses.push([type, count]));
    const lookupFn = vi.fn<Lookup>(async (ids) => {
      await g.promise;
      return Object.fromEntries(ids.map((id) => [id, { id, v: `row-${id}` }]));
    });
    const cache = buildCache(lookupFn, {}, builders);

    const a = cache.fetch([40, 41]);
    await untilGets(2);
    const b = cache.fetch([41, 42]);
    await untilGets(4);
    g.open();
    await Promise.all([a, b]);
    expect(misses.sort()).toEqual([
      ['cachedArray', 1], // b's own id 42
      ['cachedArray', 2], // a's ids 40, 41
      ['cachedArrayJoined', 1], // b's joined id 41
    ]);
  });
});

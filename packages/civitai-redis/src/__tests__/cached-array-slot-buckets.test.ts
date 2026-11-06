import calculateSlot from 'cluster-key-slot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCacheBuilders,
  createSlotBucketedKey,
  slotBucketOf,
  slotBucketTags,
  type CacheBuilderDeps,
} from '../cached-array';
import type { RedisKeyTemplateCache } from '../client';
import { createPipelinedGet } from '../cluster-pipelined-get';

/**
 * The slot-bucketed layout (`slotBuckets` + deps.isSlotBucketed) against a fake 3-master cluster
 * whose reads go through the REAL pipelined getter, so what is counted is what the client would
 * put on the wire: one entry per GET or MGET command. The fake rejects an MGET whose keys span
 * slots (CROSSSLOT), as a real cluster does, and returns a fresh copy on every read, as a decode
 * does (fetch mutates what it reads).
 *
 * Two kinds of test:
 *  - PARITY: the same scenario run once with the flag off and once on, each in its own store —
 *    outputs, origin lookups and the shape of every write must be identical.
 *  - COMMAND COUNT: the read commands for a page of N ids. Off, one per id (the control); on, at
 *    most `slotBuckets`, whatever N.
 */

const ownerOf = (slot: number) => (slot < 5461 ? 'n1' : slot < 10923 ? 'n2' : 'n3');
const KEY = 'packed:caches:test-feed-hydration' as RedisKeyTemplateCache;
const BUCKETS = 16;

type Row = { id: number; name: string; score: number; tags: number[]; label?: string };

// Pairwise-distinct fields, none equal to an id or to another row's field.
const rowFor = (id: number, version = 1): Row => ({
  id,
  name: `name-${id * 7 + 3}-v${version}`,
  score: id * 13 + 5 + version * 100_000,
  tags: [id * 3 + 1, id * 3 + 2],
});

type Cmd = string[];

function fakeCluster() {
  // value + absolute expiry (ms, on the faked Date), so EX windows really end.
  const entries = new Map<string, { value: unknown; exp?: number }>();
  const live = (k: string) => {
    const e = entries.get(k);
    if (e?.exp !== undefined && e.exp <= Date.now()) entries.delete(k);
    return entries.get(k);
  };
  const store = {
    has: (k: string) => live(k) !== undefined,
    keys: () => [...entries.keys()].filter((k) => live(k) !== undefined),
  };
  const commands: Cmd[] = [];
  const read = (k: string) => {
    const e = live(k);
    return e ? structuredClone(e.value) : null;
  };
  const pipelinedGet = createPipelinedGet<Record<string, unknown>>({
    get: async (k) => {
      commands.push(['GET', k]);
      return read(k) as Record<string, unknown> | null;
    },
    nodeOf: ownerOf,
    pipelineGet: async (_node, keys) =>
      Promise.allSettled(
        keys.map((k) => {
          commands.push(['GET', k]);
          return Promise.resolve(read(k));
        })
      ),
    pipelineCommands: async (_node, cmds) =>
      Promise.allSettled(
        cmds.map((c) => {
          commands.push(c);
          if (c[0] === 'MGET') {
            const keys = c.slice(1);
            if (new Set(keys.map((k) => calculateSlot(k))).size !== 1)
              return Promise.reject(new Error('CROSSSLOT'));
            return Promise.resolve(keys.map(read));
          }
          return Promise.resolve(read(c[1]));
        })
      ),
    track: (_n, run) => run(),
    isValue: (v): v is Record<string, unknown> => v !== null && typeof v === 'object',
    isRedirect: () => false,
  });
  const writes: { key: string; EX?: number; NX: boolean }[] = [];
  const redis = {
    packed: {
      mGet: (keys: RedisKeyTemplateCache[], opts?: { coalesceSlots?: boolean }) =>
        pipelinedGet(keys, opts?.coalesceSlots ? { coalesceSlots: true } : undefined),
      set: async (
        key: RedisKeyTemplateCache,
        value: unknown,
        opts?: { EX?: number; NX?: boolean; XX?: boolean }
      ) => {
        commands.push(['SET', key]);
        writes.push({ key, EX: opts?.EX, NX: !!opts?.NX });
        if (opts?.NX && store.has(key)) return null;
        if (opts?.XX && !store.has(key)) return null;
        entries.set(key, {
          value: structuredClone(value),
          exp: opts?.EX ? Date.now() + opts.EX * 1000 : undefined,
        });
        return 'OK';
      },
    },
    del: async (k: RedisKeyTemplateCache | RedisKeyTemplateCache[]) => {
      for (const x of [k].flat()) {
        commands.push(['DEL', x]);
        entries.delete(x);
      }
      return 1;
    },
    setNxKeepTtlWithEx: async (k: RedisKeyTemplateCache) => {
      commands.push(['SETNX', k]);
      if (store.has(k)) return false;
      entries.set(k, { value: '1' });
      return true;
    },
  };
  return { redis, store, commands, writes };
}

function world({
  on,
  swr = false,
  appendFn,
}: {
  on: boolean | (() => boolean);
  swr?: boolean;
  appendFn?: (rows: Set<Row>) => Promise<void>;
}) {
  const cluster = fakeCluster();
  const db = new Map<number, Row>();
  const lookups: number[][] = [];
  const noop = () => undefined;
  const flag = typeof on === 'function' ? on : () => on;
  const { createCachedArray } = createCacheBuilders({
    redis: cluster.redis as unknown as CacheBuilderDeps['redis'],
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
    isSlotBucketed: (cacheKey) => cacheKey === KEY && flag(),
  });
  const cache = createCachedArray<Row>({
    key: KEY,
    idKey: 'id',
    ttl: 3600,
    notFoundTtl: 600,
    staleWhileRevalidate: swr,
    debounceTime: swr ? undefined : 2,
    slotBuckets: BUCKETS,
    appendFn,
    lookupFn: async (ids) => {
      lookups.push([...ids].sort((a, b) => a - b));
      return Object.fromEntries(
        ids.filter((id) => db.has(id)).map((id) => [id, structuredClone(db.get(id) as Row)])
      );
    },
  });
  const seed = (ids: number[], version = 1) => ids.forEach((id) => db.set(id, rowFor(id, version)));
  const reads = () => cluster.commands.filter((c) => c[0] === 'GET' || c[0] === 'MGET').length;
  return { cache, db, seed, lookups, ...cluster, reads };
}

// Write shape with the layout taken out of the key, so the two modes compare.
const idOfKey = (k: string) => Number(k.slice(k.lastIndexOf(':') + 1));
const writeShape = (w: { key: string; EX?: number; NX: boolean }[]) =>
  w.map(({ key, EX, NX }) => ({ id: idOfKey(key), EX, NX }));

const range = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i * 37);

/**
 * One scenario, start to finish: full miss, full hit, partial hit with deleted ids, a changed row
 * refreshed, a deleted row refreshed, a bust, and two viewers who fetch different subsets (one has
 * hidden some ids — the caller drops them before the cache sees the ids, so what the cache returns
 * per id must not depend on who asked).
 */
async function scenario(w: ReturnType<typeof world>, advance: (ms: number) => void) {
  const out: unknown[] = [];
  const A = range(60, 1001);
  const fresh = range(30, 9001);
  const deleted = range(5, 50001);
  w.seed([...A, ...fresh]);

  out.push(['full-miss', await w.cache.fetch(A)]);
  out.push(['full-hit', await w.cache.fetch(A)]);
  const B = [...A.slice(0, 30), ...fresh, ...deleted];
  out.push(['partial-hit+deleted', await w.cache.fetch(B)]);
  out.push(['hit+notFound', await w.cache.fetch(B)]);

  // A row changes and is refreshed; another row is deleted and refreshed.
  w.db.set(A[3], rowFor(A[3], 2));
  await w.cache.refresh(A[3]);
  w.db.delete(A[4]);
  await w.cache.refresh(A[4]);
  out.push(['after-refresh', await w.cache.fetch(A.slice(0, 10))]);

  // A bust: the next reads go to origin for the window, then cache again.
  w.db.set(A[5], rowFor(A[5], 3));
  await w.cache.bust(A[5]);
  out.push(['in-bust-window', await w.cache.fetch(A.slice(0, 10))]);
  advance(5_000);
  out.push(['after-bust-window', await w.cache.fetch(A.slice(0, 10))]);

  // Two viewers: one sees every id, the other has hidden two of them.
  const page = A.slice(10, 30);
  const hidden = new Set([page[2], page[7]]);
  const everyone = await w.cache.fetch(page);
  const viewer = await w.cache.fetch(page.filter((id) => !hidden.has(id)));
  out.push(['viewer-all', everyone]);
  out.push(['viewer-hidden', viewer]);
  return out;
}

describe('slot-bucketed layout: parity with the legacy layout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

  for (const swr of [false, true]) {
    it(`returns the same items, origin lookups and writes with the flag on as off (swr=${swr})`, async () => {
      const off = world({ on: false, swr });
      const resultOff = await scenario(off, advance);
      vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
      const on = world({ on: true, swr });
      const resultOn = await scenario(on, advance);

      expect(resultOn).toEqual(resultOff);
      expect(on.lookups).toEqual(off.lookups);
      expect(writeShape(on.writes)).toEqual(writeShape(off.writes));

      // The modes really were different: only `on` sent MGETs. (Which keys each mode's FETCHES
      // touch is pinned below; an SWR invalidate reads both layouts by design.)
      expect(off.commands.some((c) => c[0] === 'MGET')).toBe(false);
      expect(on.commands.some((c) => c[0] === 'MGET')).toBe(true);
    });
  }

  it('fetches read and fill only the bucketed layout when on, only the legacy one when off', async () => {
    for (const on of [false, true]) {
      const w = world({ on });
      const ids = range(40, 6001);
      w.seed(ids.slice(0, 30)); // 10 deleted: notFound markers are fills too
      await w.cache.fetch(ids);
      await w.cache.fetch(ids);
      const touched = w.commands.flatMap((c) => c.slice(1));
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.every((k) => k.includes('{') === on)).toBe(true);
    }
  });

  it('the parity fixture is not vacuous: every per-id field differs between rows and versions', () => {
    const rows = [...range(60, 1001), ...range(30, 9001)].flatMap((id) => [
      rowFor(id, 1),
      rowFor(id, 2),
      rowFor(id, 3),
    ]);
    for (const field of ['name', 'score'] as const)
      expect(new Set(rows.map((r) => r[field])).size).toBe(rows.length);
    const ids = new Set(rows.map((r) => r.id));
    expect(rows.some((r) => ids.has(r.score))).toBe(false);
  });

  it('serves the same appendFn-decorated shape from both layouts', async () => {
    const appendFn = async (rows: Set<Row>) => {
      for (const r of rows) r.label = `label-${r.score}`;
    };
    const ids = range(40, 2001);
    const runs = [];
    for (const on of [false, true]) {
      const w = world({ on, appendFn });
      w.seed(ids);
      runs.push([await w.cache.fetch(ids), await w.cache.fetch(ids)]);
    }
    expect(runs[1]).toEqual(runs[0]);
    expect((runs[0][1][0] as Row).label).toMatch(/^label-/);
  });
});

describe('slot-bucketed layout: an invalidation reaches the layout that is not being read', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  // Both layouts can be live at once (a flip, pods disagreeing), so each test fills one layout,
  // invalidates while reading the OTHER, and reads the first one again.
  for (const [fillOn, label] of [
    [false, 'legacy'],
    [true, 'bucketed'],
  ] as const) {
    it(`refresh while reading the other layout updates the ${label} layout`, async () => {
      let on = fillOn;
      const w = world({ on: () => on });
      const ids = range(10, 3001);
      w.seed(ids);
      await w.cache.fetch(ids);
      w.db.set(ids[2], rowFor(ids[2], 2));
      on = !fillOn;
      await w.cache.refresh(ids[2]);
      on = fillOn;
      const lookupsBefore = w.lookups.length;
      const got = await w.cache.fetch(ids);
      expect(got.find((r) => r.id === ids[2])).toEqual(rowFor(ids[2], 2));
      expect(w.lookups.length).toBe(lookupsBefore);
    });

    it(`bust while reading the other layout reaches the ${label} layout`, async () => {
      let on = fillOn;
      const w = world({ on: () => on });
      const ids = range(10, 4001);
      w.seed(ids);
      await w.cache.fetch(ids);
      w.db.set(ids[6], rowFor(ids[6], 2));
      on = !fillOn;
      await w.cache.bust(ids[6]);
      on = fillOn;
      const got = await w.cache.fetch(ids);
      expect(got.find((r) => r.id === ids[6])).toEqual(rowFor(ids[6], 2));
    });

    it(`an SWR invalidate while reading the other layout reaches the ${label} layout`, async () => {
      let on = fillOn;
      const w = world({ on: () => on, swr: true });
      const ids = range(10, 5001);
      w.seed(ids);
      await w.cache.fetch(ids);
      w.db.set(ids[1], rowFor(ids[1], 2));
      on = !fillOn;
      await w.cache.bust(ids[1], { debounceTime: 0 });
      on = fillOn;
      vi.setSystemTime(new Date(Date.now() + 1_000));
      const got = await w.cache.fetch(ids);
      expect(got.find((r) => r.id === ids[1])).toEqual(rowFor(ids[1], 2));
    });
  }

  it('update() declines on a cache with slotBuckets, so its caller refreshes', async () => {
    const w = world({ on: false });
    w.seed([7001]);
    await w.cache.fetch([7001]);
    expect(await w.cache.update(7001, (r) => ({ ...r, name: 'delta' }))).toBe(false);
  });
});

describe('slot-bucketed layout: read commands per page', () => {
  async function readsForPage(on: boolean, n: number) {
    const w = world({ on });
    const ids = range(n, 100_001);
    w.seed(ids);
    await w.cache.fetch(ids); // fill
    const before = w.reads();
    const got = await w.cache.fetch(ids); // all hits
    expect(got).toHaveLength(n);
    return w.reads() - before;
  }

  it('flag on: at most slotBuckets read commands per page, whatever the page size', async () => {
    const counts: Record<number, number> = {};
    for (const n of [10, 50, 100, 200]) counts[n] = await readsForPage(true, n);
    for (const n of [10, 50, 100, 200]) expect(counts[n]).toBeLessThanOrEqual(BUCKETS);
    // Saturated: a 200-id page costs no more than a 100-id page.
    expect(counts[200]).toBe(counts[100]);
    expect(counts[200]).toBe(BUCKETS);
  });

  it('flag off (control): one read command per id', async () => {
    for (const n of [10, 50, 100, 200]) expect(await readsForPage(false, n)).toBe(n);
  });

  it('a cache without slotBuckets never asks the flag', async () => {
    const asked: string[] = [];
    const cluster = fakeCluster();
    const noop = () => undefined;
    const { createCachedArray } = createCacheBuilders({
      redis: cluster.redis as unknown as CacheBuilderDeps['redis'],
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
      isSlotBucketed: (k) => {
        asked.push(k);
        return true;
      },
    });
    const cache = createCachedArray<Row>({
      key: KEY,
      idKey: 'id',
      lookupFn: async (ids) => Object.fromEntries(ids.map((id) => [id, rowFor(id)])),
    });
    await cache.fetch(range(20, 1));
    expect(asked).toEqual([]);
    expect(cluster.commands.some((c) => c[0] === 'MGET')).toBe(false);
  });

  it('a throwing flag reads the legacy layout', async () => {
    const w = world({
      on: () => {
        throw new Error('flipt down');
      },
    });
    const ids = range(30, 1);
    w.seed(ids);
    await w.cache.fetch(ids);
    expect(w.reads()).toBeGreaterThan(0);
    expect(w.commands.some((c) => c[0] === 'MGET')).toBe(false);
    expect(w.store.keys().some((k) => k.includes('{'))).toBe(false);
  });
});

describe('slot-bucketed keys', () => {
  it('put every id of a bucket in one slot and the buckets in distinct slots', () => {
    const keyOf = createSlotBucketedKey(KEY, BUCKETS);
    const slotsByBucket = new Map<number, Set<number>>();
    for (let id = 1; id <= 2000; id++) {
      const b = slotBucketOf(id, BUCKETS);
      const s = slotsByBucket.get(b) ?? new Set<number>();
      s.add(calculateSlot(keyOf(id)));
      slotsByBucket.set(b, s);
    }
    expect(slotsByBucket.size).toBe(BUCKETS);
    for (const s of slotsByBucket.values()) expect(s.size).toBe(1);
    expect(new Set([...slotsByBucket.values()].map((s) => [...s][0])).size).toBe(BUCKETS);
  });

  it('stratify the buckets over the slot space, so contiguous masters share them evenly', () => {
    const tags = slotBucketTags(KEY, BUCKETS);
    tags.forEach((tag, b) => {
      const slot = calculateSlot(tag);
      expect(slot).toBeGreaterThanOrEqual(Math.floor((b * 16384) / BUCKETS));
      expect(slot).toBeLessThan(Math.floor(((b + 1) * 16384) / BUCKETS));
    });
    const perMaster = new Map<string, number>();
    for (const tag of tags) {
      const m = ownerOf(calculateSlot(tag));
      perMaster.set(m, (perMaster.get(m) ?? 0) + 1);
    }
    expect(Math.max(...perMaster.values()) - Math.min(...perMaster.values())).toBeLessThanOrEqual(
      1
    );
  });

  it('give two caches different slots, and an id and its decimal string the same key', () => {
    const a = slotBucketTags('packed:caches:a', BUCKETS).map((t) => calculateSlot(t));
    const b = slotBucketTags('packed:caches:b', BUCKETS).map((t) => calculateSlot(t));
    expect(a.filter((s) => b.includes(s))).toEqual([]);
    const keyOf = createSlotBucketedKey(KEY, BUCKETS);
    expect(keyOf('123457')).toBe(keyOf(123457));
    expect(keyOf(123457).startsWith(`${KEY}:{`)).toBe(true);
    expect(keyOf(123457).endsWith('}:123457')).toBe(true);
  });

  it('are pinned: a change here re-keys every bucketed cache (cold start)', () => {
    expect(createSlotBucketedKey('packed:caches:tag-ids-for-images', 16)(123456789)).toBe(
      'packed:caches:tag-ids-for-images:{y7adgy.5.60}:123456789'
    );
  });
});

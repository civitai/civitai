import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fail-open coverage for createCachedArray / createCachedObject `.fetch`.
 *
 * Background (PR #2611 + this PR): a node-redis CLUSTER (cache) command can wedge — the
 * #2556 socketTimeout / #2611 command-deadline (REDIS_CLUSTER_COMMAND_TIMEOUT_MS, lowered to
 * 3s here) now make a stuck read REJECT instead of hanging ~125s. But the cachedArray read
 * path had NO try/catch around its `redis.packed.mGet`, so that reject propagated → TRPCError
 * → 500 (a 68-min 500 spike on two wedged API pods on 2026-06-17, concentrated on the
 * createCachedObject routes tag.getAll / user.getCreator / image.getGenerationData). These
 * tests pin the contract that the read now fails OPEN to a per-id single-flighted origin
 * (lookupFn) fetch — mirroring fetchThroughCache — and that the best-effort writes/locks never
 * turn a successful origin fetch into a 500.
 *
 * The redis client is mocked so we can force a read/write rejection deterministically. The
 * fail-open logger is stubbed to a no-op (fire-and-forget Axiom/Loki I/O, not under test).
 */

// Controllable fake CLUSTER redis client. Each method can be flipped to reject to simulate a
// wedged cluster command (socketTimeout / command-deadline reject).
const mGetMock = vi.fn();
const setMock = vi.fn().mockResolvedValue(undefined);
const setNxMock = vi.fn().mockResolvedValue(true);
const delMock = vi.fn().mockResolvedValue(undefined);

// 🔴 Spread the REAL package for the key constants rather than re-typing them. The
// hand-typed copies here read TAG as 'caches:tag' and FILES_FOR_MODEL_VERSION as
// 'caches:files-for-model-version' while production uses 'tag' and
// 'packed:caches:files-for-model-version-2'. model-file.service dereferences the latter at
// MODULE scope to build filesForModelVersionCache, so the H2b block below was driving a
// cache keyed on a name Redis never sees. Client stays overridden.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  redis: {
    packed: {
      mGet: (...args: unknown[]) => mGetMock(...args),
      set: (...args: unknown[]) => setMock(...args),
    },
    setNxKeepTtlWithEx: (...args: unknown[]) => setNxMock(...args),
    del: (...args: unknown[]) => delMock(...args),
  },
  sysRedis: {},
}));

// --- H2b support: import the REAL model-file.service accessor -----------------------------------
// The H2b block drives the genuine seam — real createCachedObject + real degraded single-flight +
// real lookupFn + real getFilesForModelVersionCache — so only the leaves it cannot reach in a unit
// test (prisma, cloudflare) are stubbed. `cache-helpers` is deliberately NOT mocked here: the whole
// point is that the cache layer is real.
const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: { modelFile: { findMany: vi.fn() } },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbRead }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));

// Keep the fail-open logger inert (fire-and-forget Axiom/Loki, not under test).
vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

// Mock prom/client to assert the fail-open counters (degraded fire-rate + deduped origin
// fetches) and satisfy the other cache counters cache-helpers imports. vi.hoisted so the
// inc spies exist before the (hoisted) vi.mock factory references them.
const { degradedInc, originFetchInc } = vi.hoisted(() => ({
  degradedInc: vi.fn(),
  originFetchInc: vi.fn(),
}));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: degradedInc },
  cacheFailOpenOriginFetchCounter: { inc: originFetchInc },
}));

import { createCachedArray, createCachedObject } from '~/server/utils/cache-helpers';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';

type Row = { id: number; name: string };

const REDIS_TIMEOUT = () => new Error('redis cluster command timed out after 3000ms');

// Flush queued microtasks so all concurrent fetches reach the fail-open path before a gated
// lookupFn resolves.
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  mGetMock.mockReset();
  setMock.mockClear().mockResolvedValue(undefined);
  setNxMock.mockClear().mockResolvedValue(true);
  delMock.mockClear().mockResolvedValue(undefined);
  degradedInc.mockClear();
  originFetchInc.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCachedArray.fetch — CLUSTER read fail-open', () => {
  it('returns the ORIGIN (lookupFn) result instead of throwing when the redis read rejects', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );

    const cache = createCachedArray<Row>({ key: 'test:read' as never, idKey: 'id', lookupFn });

    // BEFORE this fix this rejected (→ TRPCError → 500). It must now resolve to the origin
    // result (degraded slow-200).
    const result = await cache.fetch([1, 2, 3]);

    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.find((r) => r.id === 2)?.name).toBe('db-2');
    // Degraded path must not attempt cache writes (redis is down).
    expect(setMock).not.toHaveBeenCalled();
    // Observability: one degraded call, and 3 ids sent to origin (the deduped DB load).
    expect(degradedInc).toHaveBeenCalledTimes(1);
    expect(degradedInc).toHaveBeenCalledWith({ cache_name: 'test:read' });
    expect(originFetchInc).toHaveBeenCalledWith({ cache_name: 'test:read' }, 3);
  });

  it('omits ids the origin has no row for (notFound semantics preserved, no throw)', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    // id 2 missing from the DB result.
    const lookupFn = vi.fn(async (ids: number[]) =>
      Object.fromEntries(ids.filter((id) => id !== 2).map((id) => [id, { id, name: `db-${id}` }]))
    );
    const cache = createCachedArray<Row>({ key: 'test:nf' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2, 3]);
    expect(result.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it('runs appendFn on the degraded results (decorator contract preserved)', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    const appendFn = vi.fn(async (rows: Set<Row>) => {
      for (const r of rows) r.name = `decorated-${r.id}`;
    });
    const cache = createCachedArray<Row>({
      key: 'test:append' as never,
      idKey: 'id',
      lookupFn,
      appendFn,
    });

    const result = await cache.fetch([7, 8]);
    expect(appendFn).toHaveBeenCalledTimes(1);
    expect(result.find((r) => r.id === 7)?.name).toBe('decorated-7');
  });

  it('PROPAGATES a genuine lookupFn (origin/DB) error — fail-open does NOT swallow it', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(async () => {
      throw new Error('db exploded');
    });
    const cache = createCachedArray<Row>({ key: 'test:dberr' as never, idKey: 'id', lookupFn });

    await expect(cache.fetch([1, 2])).rejects.toThrow('db exploded');
  });
});

describe('createCachedArray.fetch — per-id single-flight (DB stampede bound)', () => {
  it('coalesces OVERLAPPING id-sets so each id is looked up at most once concurrently', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());

    // Gated lookupFn: stays pending until released, forcing the two fetches to overlap.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lookupCalls: number[][] = [];
    const lookupFn = vi.fn(async (ids: number[]) => {
      lookupCalls.push([...ids]);
      await gate;
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<
        string,
        Row
      >;
    });

    const cache = createCachedArray<Row>({ key: 'test:sf' as never, idKey: 'id', lookupFn });

    const p1 = cache.fetch([1, 2]);
    await flush(); // let fetch#1 register ids 1,2 in the in-flight map
    const p2 = cache.fetch([2, 3]); // id 2 overlaps → must reuse, only 3 is newly fetched
    await flush();

    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // id 2 must appear in EXACTLY one lookupFn call (coalesced), never duplicated.
    const allLookedUp = lookupCalls.flat();
    expect(allLookedUp.filter((id) => id === 2)).toHaveLength(1);
    expect([...new Set(allLookedUp)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // Both callers still get their full, correct id-set back.
    expect(r1.map((r) => r.id).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(r2.map((r) => r.id).sort((a, b) => a - b)).toEqual([2, 3]);
    // The origin-fetch counter measures the DEDUPED DB load: 2 calls (degraded) but only
    // 3 ids sent to origin total (2 for [1,2] + 1 for [3]) — NOT 4 — proving the metric
    // reflects the per-id coalescing, not the raw id-set count.
    expect(degradedInc).toHaveBeenCalledTimes(2);
    const totalOriginIds = originFetchInc.mock.calls.reduce((s, c) => s + (c[1] as number), 0);
    expect(totalOriginIds).toBe(3);
  });

  it('does NOT leak in-flight entries: a fetch after settle re-issues the origin lookup', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({ key: 'test:leak' as never, idKey: 'id', lookupFn });

    await cache.fetch([5]); // settles → entry for id 5 must be deleted
    await cache.fetch([5]); // would reuse a stale promise if the map leaked
    expect(lookupFn).toHaveBeenCalledTimes(2);
  });

  it('rejects every joined caller when the shared origin fetch fails, then clears the entry', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    let calls = 0;
    const lookupFn = vi.fn(async () => {
      calls++;
      throw new Error(`db fail #${calls}`);
    });
    const cache = createCachedArray<Row>({ key: 'test:joinerr' as never, idKey: 'id', lookupFn });

    await expect(cache.fetch([9])).rejects.toThrow('db fail #1');
    // Entry cleared on rejection → next fetch issues a NEW lookup (not a stuck rejected promise).
    await expect(cache.fetch([9])).rejects.toThrow('db fail #2');
  });
});

describe('createCachedArray.fetch — HEALTHY path (regression guard)', () => {
  it('serves cache hits without an origin fetch, fetches+caches only the misses', async () => {
    // id 1 is a fresh cache hit; id 2 is a miss. mGet returns one slot per key.
    mGetMock.mockResolvedValue([{ id: 1, name: 'cached-1', cachedAt: new Date() }, null]);
    const lookupFn = vi.fn(
      async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>
    );
    const cache = createCachedArray<Row>({ key: 'test:healthy' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2]);

    // Origin fetched ONLY the miss (id 2), never the hit (id 1) → no degraded path.
    expect(lookupFn).toHaveBeenCalledTimes(1);
    expect(lookupFn).toHaveBeenCalledWith([2]);
    expect(result.find((r) => r.id === 1)?.name).toBe('cached-1'); // from cache
    expect(result.find((r) => r.id === 2)?.name).toBe('db-2'); // from origin
    expect(setMock).toHaveBeenCalled(); // the miss was written back
  });
});

describe('createCachedArray.fetch — degraded shared-object isolation (H2)', () => {
  it('clones per caller so two overlapping degraded fetches with mutating appendFns do not corrupt each other', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const lookupFn = vi.fn(async (ids: number[]) => {
      await gate;
      return Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<
        string,
        Row
      >;
    });
    // appendFn mutates the record in place (mirrors cosmeticCache/modelTagCache).
    const appendFn = async (rows: Set<Row>) => {
      for (const r of rows) r.name = `${r.name}-appended`;
    };
    const cache = createCachedArray<Row>({
      key: 'test:share' as never,
      idKey: 'id',
      lookupFn,
      appendFn,
    });

    const p1 = cache.fetch([1, 2]);
    await flush();
    const p2 = cache.fetch([2, 3]); // overlaps on id 2 → shares the in-flight promise
    await flush();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Without the clone, id 2's shared object would be appended TWICE ("db-2-appended-appended").
    expect(r1.find((r) => r.id === 2)?.name).toBe('db-2-appended');
    expect(r2.find((r) => r.id === 2)?.name).toBe('db-2-appended');
  });
});

/**
 * H2b — the degraded window OBSERVED, not inferred.
 *
 * H2 above pins the TOP-LEVEL clone. This block pins what that clone does NOT do: the record it
 * hands each caller is `{ ...r }`, so every NESTED field is still one shared reference across
 * every caller that joined the same degraded single-flight
 * (`packages/civitai-redis/src/cached-array.ts`, the `degraded.add({ ...r })` loop).
 *
 * Nothing is hand-constructed here. A rejecting `mGet` forces the real fail-open path, a gated
 * `dbRead.modelFile.findMany` holds the real `lookupFn` open so a second caller joins the same
 * in-flight promise, and the assertions read what the real `getFilesForModelVersionCache` returns.
 * The first test is the POSITIVE CONTROL: it proves this harness can actually observe nested
 * sharing, so the isolation assertions below are not passing vacuously.
 */
describe('degraded single-flight — nested `files` isolation through the real accessor (H2b)', () => {
  const VERSION_ID = 42;
  const dbRow = () => ({
    id: 1,
    name: 'base.safetensors',
    modelVersionId: VERSION_ID,
    metadata: {},
    hashes: [],
  });

  // Hold lookupFn open so a second caller reaches the fail-open path and JOINS the in-flight
  // promise rather than starting its own. Returns the gate itself as well, so a cache that does
  // NOT go through dbRead (the raw control below) can be held open by the SAME barrier — without
  // that, its first lookup resolves immediately and the second caller starts a fresh flight, which
  // yields two independent arrays and a control that "fails" for a harness reason.
  function gateOrigin() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockDbRead.modelFile.findMany.mockImplementation(async () => {
      await gate;
      return [dbRow()];
    });
    return { gate, release: () => release() };
  }

  beforeEach(() => {
    mockDbRead.modelFile.findMany.mockReset();
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
  });

  /**
   * POSITIVE CONTROL — the hazard, at the layer, as it exists today.
   *
   * 🔴 If this test ever FAILS, the shared cache layer has been fixed to deep-clone the degraded
   * record. That is the desired outcome (it is filed as a follow-up on `cached-array.ts`); when it
   * lands, delete THIS test and keep the two below — do not "repair" it by weakening them.
   */
  it('CONTROL: the RAW cache layer hands both callers the SAME nested array', async () => {
    const { gate, release } = gateOrigin();
    type Rec = { modelVersionId: number; files: { id: number }[] };
    const rawLookup = vi.fn(async (ids: number[]) => {
      await gate; // SAME barrier as the accessor tests → a real joined single-flight
      return Object.fromEntries(
        ids.map((id) => [id, { modelVersionId: id, files: [{ id: 1 }] }])
      ) as Record<string, Rec>;
    });
    const raw = createCachedObject<Rec>({
      key: 'test:h2b-raw' as never,
      idKey: 'modelVersionId',
      lookupFn: rawLookup,
    });

    const p1 = raw.fetch([VERSION_ID]);
    await flush();
    const p2 = raw.fetch([VERSION_ID]);
    await flush();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // One lookup for two callers → they genuinely joined the same degraded flight.
    expect(rawLookup).toHaveBeenCalledTimes(1);
    // Same nested array object — the shallow clone protected only the top level.
    expect(r1[VERSION_ID].files).toBe(r2[VERSION_ID].files);
    // ...and it is genuinely ONE window, not two sequential fetches.
    expect(r1[VERSION_ID]).not.toBe(r2[VERSION_ID]);
  });

  it('two callers joining ONE degraded single-flight get their OWN `files` array', async () => {
    const { release } = gateOrigin();

    const p1 = getFilesForModelVersionCache([VERSION_ID]);
    await flush();
    const p2 = getFilesForModelVersionCache([VERSION_ID]);
    await flush();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    // ONE origin lookup served BOTH callers → they really did share a single flight. Without this
    // the two `not.toBe` assertions below would pass trivially (two independent fetches).
    expect(mockDbRead.modelFile.findMany).toHaveBeenCalledTimes(1);
    expect(degradedInc).toHaveBeenCalledTimes(2); // both callers took the degraded path
    expect(r1[VERSION_ID].files).toHaveLength(1);
    expect(r2[VERSION_ID].files).toHaveLength(1);
    expect(r1[VERSION_ID].files).not.toBe(r2[VERSION_ID].files);
  });

  it('one caller appending a linked VAE file is INVISIBLE to the other', async () => {
    const { release } = gateOrigin();

    const p1 = getFilesForModelVersionCache([VERSION_ID]);
    await flush();
    const p2 = getFilesForModelVersionCache([VERSION_ID]);
    await flush();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockDbRead.modelFile.findMany).toHaveBeenCalledTimes(1);
    // The behaviour `getModelsWithVersions` used to perform in place on this very array.
    (r1[VERSION_ID].files as unknown[]).push({ id: 999, name: 'linked.vae.safetensors' });

    expect(r1[VERSION_ID].files).toHaveLength(2);
    expect(r2[VERSION_ID].files).toHaveLength(1);
    expect(r2[VERSION_ID].files.map((f) => f.name)).toEqual(['base.safetensors']);
  });
});

describe('createCachedObject.fetch — fail-open + best-effort writes', () => {
  it('fails open to a keyed Record from the origin when the read rejects', async () => {
    mGetMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    const cache = createCachedObject<Row>({ key: 'test:obj' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2]);
    expect(Object.keys(result).sort()).toEqual(['1', '2']);
    expect(result['2'].name).toBe('db-2');
  });

  it('does NOT 500 when the cache WRITE-back rejects after a successful origin miss-fetch', async () => {
    // Healthy read (empty → all misses), but the write-back to redis rejects (partial wedge).
    mGetMock.mockResolvedValue([]); // no cached entries → every id is a miss
    setMock.mockRejectedValue(REDIS_TIMEOUT());
    const lookupFn = async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { id, name: `db-${id}` }])) as Record<string, Row>;
    // cacheNotFound default true → notFound writes also attempted; both must be swallowed.
    const cache = createCachedObject<Row>({ key: 'test:wb' as never, idKey: 'id', lookupFn });

    const result = await cache.fetch([1, 2]);
    expect(setMock).toHaveBeenCalled(); // it tried to write
    expect(Object.keys(result).sort()).toEqual(['1', '2']); // and still returned the data
  });
});

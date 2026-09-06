import { pack } from 'msgpackr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SEAM coverage for the packed brotli codec's prom instrumentation
 * (`civitai_app_packed_codec_duration_seconds`, labels `op` + `cache_name`).
 *
 * WHY THIS DRIVES THE REAL CLIENT. The unit test beside this one
 * (./packed-codec-timing.test.ts) proves `compressPacked`/`decompressPacked` CALL their timing
 * callback. That is a claim about one module. The thing that can actually be wrong in production
 * is the SEAM: whether `client.packed.set/get/mGet` pass a callback at all, whether it reaches the
 * globalThis metrics bridge the app publishes, and whether the `cache_name` it carries is the
 * bounded cache PREFIX rather than a per-id key. A test that mocked `packed` would pass against a
 * client that instruments nothing.
 *
 * So the only faked thing here is the TRANSPORT: `redis`'s client factory is replaced by an
 * in-memory server holding raw Buffers (same approach as ./cached-array-compress.test.ts).
 * `createCacheRedis`, `client.packed.*`, the msgpack + brotli codec, `createCacheBuilders` and the
 * bridge lookup are all the real modules.
 */

// process.env must be populated BEFORE ../client is imported: loadRedisEnv() validates it.
vi.hoisted(() => {
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_SYS_URL ??= 'redis://localhost:6379';
  process.env.REDIS_CLUSTER = 'false';
});

/** The in-memory "server": key -> raw stored bytes, exactly as a real Redis would hold them. */
const { store } = vi.hoisted(() => ({ store: new Map<string, Buffer>() }));

vi.mock('redis', () => {
  const toBuffer = (v: unknown): Buffer =>
    Buffer.isBuffer(v) ? v : Buffer.from(v as string, 'binary');

  const makeClient = (bufferMode = false): Record<string, unknown> => {
    const self: Record<string, any> = {
      connect: () => Promise.resolve(self),
      on: () => self,
      withTypeMapping: () => makeClient(true),
      get: async (key: string) => {
        const v = store.get(key);
        if (v === undefined) return null;
        return bufferMode ? v : v.toString('binary');
      },
      set: async (key: string, value: unknown, options?: { NX?: boolean; XX?: boolean }) => {
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

import { createCacheBuilders } from '../cached-array';
import { createCacheRedis, PACKED_CODEC_UNNAMED_CACHE } from '../client';
import type { RedisKeyTemplateCache } from '../client';
import { compressPacked } from '../packed-compression';

const redis = createCacheRedis();

type Observation = { op: string; cache_name: string; seconds: number };
let observed: Observation[] = [];

/**
 * Stand-in for what `src/server/prom/client.ts` publishes on globalThis. Only the handle under
 * test is populated: the client reads each handle independently, so an over-complete fake would
 * hide a wiring mistake behind a shape that production does not have to have.
 */
function installBridge() {
  (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = {
    packedCodecDuration: {
      observe: (labels: { op: string; cache_name: string }, value: number) =>
        observed.push({ op: labels.op, cache_name: labels.cache_name, seconds: value }),
    },
  };
}

function removeBridge() {
  delete (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics;
}

// Distinct, non-overlapping label values so a mutant that hardcodes or swaps one is visible.
// None of them equals PACKED_CODEC_UNNAMED_CACHE, which is asserted separately.
const DIRECT_CACHE = 'packed:caches:test-codec-direct';
const BUILDER_CACHE = 'packed:caches:test-codec-builder' as RedisKeyTemplateCache;
const KEY = 'packed:caches:test-codec-direct:v1' as RedisKeyTemplateCache;
const KEY_LEGACY = 'packed:caches:test-codec-direct:v2' as RedisKeyTemplateCache;

// Redundant payload: brotli must produce a genuinely smaller, sentinel-tagged value.
const blob = 'prompt, masterpiece, highly detailed, '.repeat(120);
const record = { id: 7, blob, cachedAt: 1_700_000_000_000 };

beforeEach(() => {
  store.clear();
  observed = [];
  installBridge();
});

describe('packed codec metrics — write path', () => {
  it('a compressed set observes exactly one compress sample under the given cache_name', async () => {
    await redis.packed.set(KEY, record, undefined, {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(observed).toEqual([
      { op: 'compress', cache_name: DIRECT_CACHE, seconds: expect.any(Number) },
    ]);
  });

  it('an UNCOMPRESSED set observes nothing (no codec ran)', async () => {
    await redis.packed.set(KEY, record);
    expect(observed).toEqual([]);
  });
});

describe('packed codec metrics — read path', () => {
  it('a compressed get observes exactly one decompress sample under the given cache_name', async () => {
    store.set(KEY, await compressPacked(Buffer.from(pack(record))));
    observed = [];

    const got = await redis.packed.get<typeof record>(KEY, {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(got).toEqual(record); // the read still works
    expect(observed).toEqual([
      { op: 'decompress', cache_name: DIRECT_CACHE, seconds: expect.any(Number) },
    ]);
  });

  // 🔴 The legacy pre-compression value is a sentinel check and a return, not a codec call.
  // Counting it would make the histogram report the cost of NOT decompressing.
  it('a LEGACY (uncompressed) value read through the compress-aware get observes nothing', async () => {
    store.set(KEY_LEGACY, Buffer.from(pack(record)));

    const got = await redis.packed.get<typeof record>(KEY_LEGACY, {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(got).toEqual(record); // back-compat decode still works
    expect(observed).toEqual([]);
  });

  it('a compressed mGet observes one decompress per COMPRESSED value only', async () => {
    store.set(KEY, await compressPacked(Buffer.from(pack(record))));
    store.set(KEY_LEGACY, Buffer.from(pack(record))); // legacy sibling in the same batch
    observed = [];

    const got = await redis.packed.mGet<typeof record>([KEY, KEY_LEGACY], {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(got).toEqual([record, record]); // both decode
    expect(observed).toEqual([
      { op: 'decompress', cache_name: DIRECT_CACHE, seconds: expect.any(Number) },
    ]);
  });

  it('an UNCOMPRESSED get observes nothing', async () => {
    await redis.packed.set(KEY, record);
    observed = [];
    await redis.packed.get<typeof record>(KEY);
    expect(observed).toEqual([]);
  });
});

describe('packed codec metrics — labels and wiring', () => {
  it('falls back to the explicit unnamed-cache label when no cacheName is given', async () => {
    await redis.packed.set(KEY, record, undefined, { compress: true });
    expect(observed.map((o) => o.cache_name)).toEqual([PACKED_CODEC_UNNAMED_CACHE]);
  });

  it('does not throw when the app has published no metrics bridge', async () => {
    // NOTE: absence is a no-op — `?.` short-circuits and no callback runs. That is a strictly
    // weaker claim than the throwing-bridge block below, which is where the damage lives.
    removeBridge();
    await expect(
      redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE })
    ).resolves.toBeDefined();
    const got = await redis.packed.get<typeof record>(KEY, {
      compress: true,
      cacheName: DIRECT_CACHE,
    });
    expect(got).toEqual(record);
    installBridge();
  });

  // The label must be the cache PREFIX. `createCachedObject` writes/reads `${key}:${id}`, so
  // labelling with the per-id key would make `cache_name` unbounded — one series per cached id.
  it('createCachedObject labels with the cache PREFIX, never the per-id key', async () => {
    const noop = () => undefined;
    const { createCachedObject } = createCacheBuilders({
      redis,
      defaultTtl: 300,
      metrics: {
        hit: noop,
        miss: noop,
        revalidate: noop,
        failOpenDegraded: noop,
        failOpenOriginFetch: noop,
      },
      logFailOpen: noop,
      logRefreshError: noop,
      log: noop,
      clearByPattern: async () => undefined,
    });
    const cache = createCachedObject<{ id: number; blob: string }>({
      key: BUILDER_CACHE,
      idKey: 'id',
      lookupFn: async (ids: number[]) =>
        Object.fromEntries(ids.map((id) => [id, { id, blob }])) as Record<
          string,
          { id: number; blob: string }
        >,
      ttl: 3600,
      compress: true,
    });

    await cache.fetch([11, 22]); // miss → lookup → compressed writes
    const writeLabels = new Set(
      observed.filter((o) => o.op === 'compress').map((o) => o.cache_name)
    );
    expect(writeLabels).toEqual(new Set([BUILDER_CACHE]));

    observed = [];
    await cache.fetch([11, 22]); // hit → compressed reads
    const readLabels = new Set(
      observed.filter((o) => o.op === 'decompress').map((o) => o.cache_name)
    );
    expect(readLabels).toEqual(new Set([BUILDER_CACHE]));
    expect(observed.filter((o) => o.op === 'decompress')).toHaveLength(2);
  });
});

/**
 * 🔴 A METRICS FAULT MUST NOT DESTROY A CACHE ENTRY.
 *
 * The timer call sits INSIDE `decompressPacked`, which sits inside `safeUnpackCompressed`'s try —
 * and that catch does not mean "something went wrong", it means "the stored bytes are corrupt", so
 * it logs, UNLINKS the key and returns null. A bridge whose `observe()` throws (duplicate metric
 * registration, a rejected label value, an exhausted registry) therefore does not merely lose a
 * sample: a VALID entry is reported as a miss and DELETED, on every read, for as long as the fault
 * lasts — an observability change turning into a cache-eviction bug that presents as a cache with
 * a mysterious 0% hit rate.
 *
 * The "no metrics bridge" test above cannot see this: absence short-circuits at `?.` and no
 * callback runs at all. Absence and throw are different mechanisms, and only one of them is
 * dangerous.
 */
describe('packed codec metrics — a metrics fault must never fail a read or a write', () => {
  /**
   * Counts every call BEFORE throwing. The count is the positive control: without it, all three
   * tests below would also pass against a client that had stopped calling the timer entirely —
   * "nothing threw" is exactly what a dead wire looks like too. Asserting `attempts > 0` says the
   * throwing path was really entered and really swallowed.
   */
  let attempts = 0;
  const BOOM = 'prom registry exploded';

  function installThrowingBridge() {
    attempts = 0;
    (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = {
      packedCodecDuration: {
        observe: () => {
          attempts += 1;
          throw new Error(BOOM);
        },
      },
    };
  }

  it('a throwing observe() neither loses the value nor unlinks the key on a compressed get', async () => {
    store.set(KEY, await compressPacked(Buffer.from(pack(record))));
    installThrowingBridge();

    const got = await redis.packed.get<typeof record>(KEY, {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(attempts, 'the throwing observe() was actually reached').toBe(1);
    // Asserted BEFORE the value: the deletion is the damaging half, and it outlives the request.
    expect(store.has(KEY), 'the healthy entry was NOT unlinked by a metrics fault').toBe(true);
    expect(got, 'a valid entry is still returned when the metrics bridge throws').toEqual(record);
  });

  it('a throwing observe() does not fail a compressed set', async () => {
    installThrowingBridge();

    await expect(
      redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE })
    ).resolves.toBeDefined();
    expect(attempts, 'the throwing observe() was actually reached').toBe(1);
    expect(store.has(KEY), 'the compressed write still landed').toBe(true);
  });

  it('a throwing observe() leaves a whole compressed mGet batch intact', async () => {
    store.set(KEY, await compressPacked(Buffer.from(pack(record))));
    store.set(KEY_LEGACY, await compressPacked(Buffer.from(pack(record))));
    installThrowingBridge();

    const got = await redis.packed.mGet<typeof record>([KEY, KEY_LEGACY], {
      compress: true,
      cacheName: DIRECT_CACHE,
    });

    expect(attempts, 'the throwing observe() was reached once per compressed value').toBe(2);
    expect(
      [store.has(KEY), store.has(KEY_LEGACY)],
      'no key in the batch was unlinked by a metrics fault'
    ).toEqual([true, true]);
    expect(got, 'every entry in the batch still decodes').toEqual([record, record]);
  });
});

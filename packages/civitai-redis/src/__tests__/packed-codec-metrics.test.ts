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
import {
  createCacheRedis,
  PACKED_CODEC_UNNAMED_CACHE,
  __resetPackedCodecObserveFailureState,
} from '../client';
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

/**
 * 🔴 A SWALLOWED FAILURE MUST NOT BE A SILENT ONE.
 *
 * The block above proves the catch protects the cache. It says nothing about whether anyone would
 * ever find out. A bridge whose `observe()` throws on every call yields a histogram that never has
 * data — which is byte-for-byte what "no cache opted into compress" looks like, on the only metric
 * that can answer whether compression is worth its cost. A reassuring zero is indistinguishable
 * from a probe wired to nothing, so the catch has to say so.
 *
 * It is rate-limited rather than one-shot: a throwing bridge throws on EVERY codec call, so an
 * unthrottled line would be per-cache-read log spam, while a strict one-shot would go quiet for the
 * whole life of the process no matter how long the fault lasted. The three properties below are
 * asserted in one test on purpose — the throttle is module-scoped state, so "did not log" only
 * means "throttled" relative to a known earlier log in the same sequence.
 */
describe('packed codec metrics — a swallowed observe failure leaves a breadcrumb', () => {
  const BREADCRUMB = 'packed codec metrics observe FAILED';
  const BOOM_MSG = 'prom registry exploded';
  let attempts = 0;

  function installThrowingBridgeHere() {
    attempts = 0;
    (globalThis as unknown as { __civitaiRedisMetrics?: unknown }).__civitaiRedisMetrics = {
      packedCodecDuration: {
        observe: () => {
          attempts += 1;
          throw new Error(BOOM_MSG);
        },
      },
    };
  }

  it('logs the first failure, throttles the next, and speaks again once the window has passed', async () => {
    __resetPackedCodecObserveFailureState();
    const lines: string[] = [];
    // `log` is module-scoped in ../client and injected here; this rebinds it for the rest of the
    // file, which is why the bridge is restored in the `finally` below.
    createCacheRedis({ log: (msg: string) => lines.push(String(msg)) });
    installThrowingBridgeHere();

    // A controlled clock: the throttle reads Date.now(). Nothing else on this path does — the
    // deadline wrapper uses setTimeout — so freezing it cannot stall the client.
    let clock = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const breadcrumbs = () => lines.filter((l) => l.includes(BREADCRUMB));

    try {
      await redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE });

      // Positive control: the throwing path was actually entered. Without it every "logged N
      // times" assertion below would also hold against a client that stopped timing entirely.
      expect(attempts, 'the throwing observe() was actually reached').toBe(1);
      expect(breadcrumbs(), 'the FIRST swallowed failure is reported').toHaveLength(1);
      // The line has to be diagnosable on its own: which op, which cache, and the underlying
      // error. A bare "metrics failed" would not distinguish this from any other swallow.
      expect(breadcrumbs()[0]).toContain('op=compress');
      expect(breadcrumbs()[0]).toContain(DIRECT_CACHE);
      expect(breadcrumbs()[0]).toContain(BOOM_MSG);
      expect(breadcrumbs()[0]).toContain('failures=1');

      // Same window → counted, not logged.
      await redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE });
      expect(attempts, 'the second failure really happened').toBe(2);
      expect(
        breadcrumbs(),
        'a second failure inside the window is throttled, not logged'
      ).toHaveLength(1);

      // Past the window → speaks again, and carries the count accumulated while it was quiet.
      clock += 60_001;
      await redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE });
      expect(breadcrumbs(), 'the breadcrumb returns after the throttle window').toHaveLength(2);
      expect(
        breadcrumbs()[1],
        'the throttled failures are still counted, so the line reports 3 rather than 1'
      ).toContain('failures=3');
    } finally {
      nowSpy.mockRestore();
      createCacheRedis({ log: () => undefined });
      installBridge();
      __resetPackedCodecObserveFailureState();
    }
  });

  it('NEGATIVE CONTROL: a healthy bridge logs no breadcrumb at all', async () => {
    __resetPackedCodecObserveFailureState();
    const lines: string[] = [];
    createCacheRedis({ log: (msg: string) => lines.push(String(msg)) });
    installBridge();

    try {
      await redis.packed.set(KEY, record, undefined, { compress: true, cacheName: DIRECT_CACHE });
      expect(observed, 'the healthy bridge really did receive the sample').toHaveLength(1);
      expect(lines.filter((l) => l.includes(BREADCRUMB))).toHaveLength(0);
    } finally {
      createCacheRedis({ log: () => undefined });
      __resetPackedCodecObserveFailureState();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClientModule from '@civitai/redis/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * NAMESPACED half of the coverage for namespace-scoping the admin cache-clear path (the
 * production half is cache-helpers-clear-namespace-prod.test.ts — the two cannot share a file
 * because a `vi.mock` factory is evaluated once per file, so `CACHE_KEY_NAMESPACE` cannot be
 * flipped between cases; same split as the cache-helpers-key-prefix-*.test.ts pair).
 *
 * 🔴 The hazard being pinned: a cache-clear glob is written by hand against the PRODUCTION key
 * shape (`packed:caches:*`), and every deployment shares ONE cache instance. Unscoped, such a glob
 * run from a namespaced deployment matches production's keys and NONE of its own — the single
 * environment it can clear is the one it must never touch. Every case below therefore seeds a
 * production-shaped key alongside the namespaced one and asserts the production key SURVIVES.
 *
 * Each guard is exercised through the path where it is the ONLY thing standing between the input
 * and a foreign `del`, so a test cannot go green on a neighbouring guard's behalf: the endpoint
 * cases pin the scoping of a caller glob, the direct-helper cases pass a DELIBERATELY UNSCOPED
 * pattern to pin the helper-side containment.
 */

vi.hoisted(() => {
  process.env.CACHE_KEY_NAMESPACE = 'preview';
  delete process.env.IS_PREVIEW;
});

/**
 * Stand-in for a Redis client. `scanIterator` models the SERVER-side semantics of `SCAN MATCH`
 * (only keys matching the glob are ever returned to the client) — that is what makes a `MATCH`
 * confinement structural rather than cosmetic, so the fake has to honour it. The glob→regex here
 * is deliberately its own hand-written implementation: it models Redis, not the helper under test.
 */
const { mainFake, sysFake } = vi.hoisted(() => {
  const globToRegExp = (glob: string) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

  const makeFake = () => {
    const store = new Set<string>();
    const deleted: string[] = [];
    const scanMatches: string[] = [];
    const enumerated: string[] = [];
    return {
      store,
      deleted,
      scanMatches,
      enumerated,
      reset() {
        store.clear();
        deleted.length = 0;
        scanMatches.length = 0;
        enumerated.length = 0;
      },
      client: {
        del: async (key: string) => {
          deleted.push(key);
          return store.delete(key) ? 1 : 0;
        },
        scanIterator: ({ MATCH }: { MATCH: string; COUNT?: number }) => {
          scanMatches.push(MATCH);
          const re = globToRegExp(MATCH);
          const batch = [...store].filter((k) => re.test(k));
          enumerated.push(...batch);
          return (async function* () {
            yield batch;
          })();
        },
      },
    };
  };

  return { mainFake: makeFake(), sysFake: makeFake() };
});

vi.mock('~/server/redis/client', async () => {
  const pkg = await vi.importActual<typeof RedisClientModule>('@civitai/redis/client');
  return { ...pkg, redis: mainFake.client, sysRedis: sysFake.client };
});

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/prom/client', () => ({
  cacheHitCounter: { inc: vi.fn() },
  cacheMissCounter: { inc: vi.fn() },
  cacheRevalidateCounter: { inc: vi.fn() },
  cacheFailOpenDegradedCounter: { inc: vi.fn() },
  cacheFailOpenOriginFetchCounter: { inc: vi.fn() },
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

type JsonRes = {
  statusCode?: number;
  body?: unknown;
  status: (code: number) => JsonRes;
  json: (body: unknown) => JsonRes;
  setHeader: () => void;
  flushHeaders: () => void;
  write: (chunk: string) => void;
  end: () => void;
  chunks: string[];
};
function makeRes(): JsonRes {
  const res: JsonRes = {
    chunks: [],
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write(chunk) {
      res.chunks.push(chunk);
    },
    end: vi.fn(),
  };
  return res;
}

const loadEndpoint = async () =>
  (await import('~/pages/api/admin/clear-cache-by-pattern')).default as (
    req: unknown,
    res: unknown
  ) => Promise<void>;

// Production-shaped keys — what this deployment must never be able to delete.
const FOREIGN_KEYS = [
  'packed:caches:user-cosmetics:1',
  'packed:caches:user-cosmetics:2',
  'packed:caches:tag-ids-for-images:7',
];
// This deployment's own keys, as `applyCacheKeyPrefix` mints them.
const OWN_KEYS = [
  'preview:packed:caches:user-cosmetics:1',
  'preview:packed:caches:tag-ids-for-images:7',
];

describe('admin cache-clear namespace scoping — namespaced deployment', () => {
  beforeEach(() => {
    mainFake.reset();
    sysFake.reset();
    for (const k of [...FOREIGN_KEYS, ...OWN_KEYS]) mainFake.store.add(k);
    // System keys are UNPREFIXED on every deployment — they are never run through
    // `applyCacheKeyPrefix`. Seeded exactly as they appear anywhere.
    sysFake.store.add('device:accounts:1');
    sysFake.store.add('device:accounts:2');
  });

  it('scopes a main-cache pattern and leaves a sys pattern alone', async () => {
    const { scopeCachePatternToNamespace } = await import('~/server/utils/cache-helpers');

    expect(scopeCachePatternToNamespace('packed:caches:*')).toBe('preview:packed:caches:*');
    expect(scopeCachePatternToNamespace('packed:caches:*', 'main')).toBe('preview:packed:caches:*');
    // 🔴 Deliberate asymmetry: system keys are never namespaced, so prefixing one would match
    // nothing. This pins the mechanism — it is NOT an assertion that the sys target is contained.
    // See the `cacheNamespacePrefix` doc block: a sys clear can reach production data.
    expect(scopeCachePatternToNamespace('device:accounts:*', 'sys')).toBe('device:accounts:*');
  });

  it('the endpoint scopes the caller glob and cannot reach a production key', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler({ query: { pattern: 'packed:caches:*' } }, res);

    expect(mainFake.scanMatches).toEqual(['preview:packed:caches:*']);
    // Positive control: it really cleared its OWN keys (a zero here would be indistinguishable
    // from a clear that silently did nothing).
    expect(res.body).toEqual({ ok: true, cleared: 2, target: 'main' });
    expect([...mainFake.deleted].sort()).toEqual([...OWN_KEYS].sort());
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('the endpoint scopes every pattern on the multi-pattern path', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler(
      { query: { patterns: 'packed:caches:user-cosmetics:*,packed:caches:tag-ids-for-images:*' } },
      res
    );

    expect(res.body).toEqual({
      ok: true,
      cleared: 2,
      target: 'main',
      perPattern: [
        { pattern: 'preview:packed:caches:user-cosmetics:*', cleared: 1 },
        { pattern: 'preview:packed:caches:tag-ids-for-images:*', cleared: 1 },
      ],
    });
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPattern deletes nothing when handed an UNSCOPED glob', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    // No endpoint in front of it: the helper's own containment filter is the only guard here.
    const cleared = await clearCacheByPattern('packed:caches:*');

    expect(cleared).toEqual([]);
    expect(mainFake.deleted).toEqual([]);
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPattern deletes nothing when handed an UNSCOPED exact key', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    const cleared = await clearCacheByPattern('packed:caches:user-cosmetics:1');

    expect(cleared).toEqual([]);
    expect(mainFake.deleted).toEqual([]);
    expect(mainFake.store.has('packed:caches:user-cosmetics:1')).toBe(true);
  });

  it('clearCacheByPattern still clears the deployment’s own keys', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    const cleared = await clearCacheByPattern('preview:packed:caches:*');

    expect([...cleared].sort()).toEqual([...OWN_KEYS].sort());
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPatterns confines its SCAN so a production key is never even enumerated', async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns(['preview:packed:caches:user-cosmetics:*']);

    expect(mainFake.scanMatches).toEqual(['preview:*']);
    // The scan saw ONLY this deployment's keys. Positive control on the same assertion: it did
    // see them, so an empty enumeration cannot pass as confinement.
    expect([...mainFake.enumerated].sort()).toEqual([...OWN_KEYS].sort());
    expect(results).toEqual([{ pattern: 'preview:packed:caches:user-cosmetics:*', cleared: 1 }]);
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPatterns deletes nothing when handed UNSCOPED globs', async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns(['packed:caches:*', 'packed:caches:*:7']);

    expect(results).toEqual([
      { pattern: 'packed:caches:*', cleared: 0 },
      { pattern: 'packed:caches:*:7', cleared: 0 },
    ]);
    expect(mainFake.deleted).toEqual([]);
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPatterns deletes nothing on the exact-key fast path when UNSCOPED', async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns([
      'packed:caches:user-cosmetics:1',
      'packed:caches:user-cosmetics:2',
    ]);

    expect(results).toEqual([
      { pattern: 'packed:caches:user-cosmetics:1', cleared: 0 },
      { pattern: 'packed:caches:user-cosmetics:2', cleared: 0 },
    ]);
    expect(mainFake.deleted).toEqual([]);
    expect(mainFake.scanMatches).toEqual([]);
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  it('clearCacheByPatterns still clears own keys on the exact-key fast path', async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns(['preview:packed:caches:user-cosmetics:1']);

    expect(results).toEqual([{ pattern: 'preview:packed:caches:user-cosmetics:1', cleared: 1 }]);
    expect(mainFake.deleted).toEqual(['preview:packed:caches:user-cosmetics:1']);
  });

  // 🔴 THE SSE BRANCH IS A SEPARATE CALL SITE, and it is the one used for large clears. It reads
  // `patterns` independently of the non-streaming branch below it, so scoping can regress on this
  // path alone while every non-streaming case stays green. Covering it only in the production
  // suite proves nothing about scoping, because there scoping is the identity function.
  it('scopes the caller patterns on the SSE path and reports the scoped patterns', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler(
      {
        query: {
          patterns: 'packed:caches:user-cosmetics:*,packed:caches:tag-ids-for-images:*',
          stream: '1',
        },
      },
      res
    );

    const events = res.chunks
      .filter((c) => c.startsWith('event: '))
      .map((c) => {
        const [eventLine, dataLine] = c.split('\n');
        return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice(6)) };
      });

    // 🔴 ASSERTION ORDER IS LOAD-BEARING — the SCOPING assertions come first, and events are
    // looked up BY NAME rather than by index.
    //
    // An unscoped SSE branch matches nothing, and `clearCacheByPatterns` skips its `onProgress`
    // callback on a batch that deletes nothing (`if (toDelete.length === 0) continue`), so the
    // `progress` event disappears entirely. An event-sequence assertion placed first therefore
    // fails on the SHAPE of the stream — a true failure, but one that says nothing about
    // scoping — and an `events[2]` index would read `undefined` and throw instead of asserting.
    // Verified: ordered that way, the mutant failed with
    // `expected [ 'start', 'done' ] to deeply equal [ 'start', 'progress', 'done' ]`.
    const byName = (name: string) => events.find((e) => e.event === name);

    // The clear reports the SCOPED patterns, and the counts are NON-ZERO. Both halves matter: an
    // unscoped glob reports the raw patterns and clears 0, and a bare "production survived" check
    // cannot tell that apart from a clear that silently did nothing.
    expect(byName('done')?.data).toEqual({
      total: 2,
      perPattern: [
        { pattern: 'preview:packed:caches:user-cosmetics:*', cleared: 1 },
        { pattern: 'preview:packed:caches:tag-ids-for-images:*', cleared: 1 },
      ],
    });

    // The announced patterns are the SCOPED ones — what the clear will actually address.
    expect(byName('start')?.data).toEqual({
      patterns: [
        'preview:packed:caches:user-cosmetics:*',
        'preview:packed:caches:tag-ids-for-images:*',
      ],
      target: 'main',
    });

    expect(byName('progress')?.data).toEqual({
      total: 2,
      perPattern: [
        { pattern: 'preview:packed:caches:user-cosmetics:*', cleared: 1 },
        { pattern: 'preview:packed:caches:tag-ids-for-images:*', cleared: 1 },
      ],
    });

    expect([...mainFake.deleted].sort()).toEqual([...OWN_KEYS].sort());
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);

    // Stream shape last: a real property, but it must not be what a scoping regression trips on.
    expect(events.map((e) => e.event)).toEqual(['start', 'progress', 'done']);
  });

  it('scopes a single caller pattern on the SSE path', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler({ query: { pattern: 'packed:caches:*', stream: '1' } }, res);

    const events = res.chunks
      .filter((c) => c.startsWith('event: '))
      .map((c) => {
        const [eventLine, dataLine] = c.split('\n');
        return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice(6)) };
      });

    // Scoping first, by name — see the ordering note on the multi-pattern SSE case above.
    const byName = (name: string) => events.find((e) => e.event === name);

    expect(byName('done')?.data).toEqual({
      total: 2,
      perPattern: [{ pattern: 'preview:packed:caches:*', cleared: 2 }],
    });
    expect(byName('start')?.data).toEqual({
      patterns: ['preview:packed:caches:*'],
      target: 'main',
    });
    expect([...mainFake.deleted].sort()).toEqual([...OWN_KEYS].sort());
    for (const k of FOREIGN_KEYS) expect(mainFake.store.has(k)).toBe(true);
  });

  // 🔴 The sys target must behave EXACTLY as it does in production, because system keys are
  // unprefixed everywhere and scoping one would make the clear match nothing.
  //
  // 🔴 READ THIS AS A MECHANISM TEST, NOT A SAFETY TEST. It pins that the namespace does not
  // reach the sys pattern. It does NOT show that a sys clear is confined to this deployment —
  // a deployment's system-Redis instance is not guaranteed to be distinct from production's, so
  // this call can delete production data. See `cacheNamespacePrefix`.
  it('does not apply the namespace to a sys pattern (mechanism, not containment)', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler({ query: { pattern: 'device:accounts:*', target: 'sys' } }, res);

    expect(sysFake.scanMatches).toEqual(['device:accounts:*']);
    expect([...sysFake.deleted].sort()).toEqual(['device:accounts:1', 'device:accounts:2']);
    expect(res.body).toEqual({ ok: true, cleared: 2, target: 'sys' });
    expect(mainFake.deleted).toEqual([]);
  });

  it('scans the whole sys keyspace on the multi-pattern sys path', async () => {
    const handler = await loadEndpoint();
    const res = makeRes();

    await handler(
      { query: { patterns: 'device:accounts:*,device:sessions:*', target: 'sys' } },
      res
    );

    expect(sysFake.scanMatches).toEqual(['*']);
    expect(res.body).toEqual({
      ok: true,
      cleared: 2,
      target: 'sys',
      perPattern: [
        { pattern: 'device:accounts:*', cleared: 2 },
        { pattern: 'device:sessions:*', cleared: 0 },
      ],
    });
  });

  it('deletes an exact sys key without a namespace prefix', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    const cleared = await clearCacheByPattern('device:accounts:1', undefined, 'sys');

    expect(cleared).toEqual(['device:accounts:1']);
    expect(sysFake.deleted).toEqual(['device:accounts:1']);
    expect(sysFake.store.has('device:accounts:1')).toBe(false);
  });
});

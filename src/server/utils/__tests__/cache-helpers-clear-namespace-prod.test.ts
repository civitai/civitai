import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisClientModule from '@civitai/redis/client';

/**
 * PRODUCTION half of the coverage for namespace-scoping the admin cache-clear path (the
 * namespaced half is cache-helpers-clear-namespace-preview.test.ts — the two cannot share a file
 * because a `vi.mock` factory is evaluated once per file, so `CACHE_KEY_NAMESPACE` cannot be
 * flipped between cases; same split as the cache-helpers-key-prefix-*.test.ts pair).
 *
 * 🔴 This file is the one that pins "production behaviour does not move". With no namespace
 * configured, the pattern that reaches Redis, the `MATCH` the SCAN is issued with, and the set of
 * keys that gets deleted must be byte-identical to what they were before scoping existed. Every
 * expectation is a hand-written literal, never a value recomputed from the code under test.
 */

vi.hoisted(() => {
  delete process.env.CACHE_KEY_NAMESPACE;
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
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

// The endpoint's only non-trivial dependency besides cache-helpers. Replaced with a pass-through
// so the real handler body runs; the auth wrapper is not what this file is about.
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

describe('admin cache-clear namespace scoping — production (no namespace)', () => {
  const PROD_KEYS = [
    'packed:caches:user-cosmetics:1',
    'packed:caches:user-cosmetics:2',
    'packed:caches:tag-ids-for-images:7',
    'unrelated:thing:1',
  ];

  beforeEach(() => {
    mainFake.reset();
    sysFake.reset();
    for (const k of PROD_KEYS) mainFake.store.add(k);
    sysFake.store.add('device:accounts:1');
    sysFake.store.add('device:accounts:2');
  });

  it('leaves a pattern untouched — main and sys alike', async () => {
    const { scopeCachePatternToNamespace } = await import('~/server/utils/cache-helpers');

    expect(scopeCachePatternToNamespace('packed:caches:*')).toBe('packed:caches:*');
    expect(scopeCachePatternToNamespace('packed:caches:*', 'main')).toBe('packed:caches:*');
    expect(scopeCachePatternToNamespace('device:accounts:*', 'sys')).toBe('device:accounts:*');
  });

  it('clearCacheByPattern scans with the caller pattern verbatim and clears the same keys', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    const cleared = await clearCacheByPattern('packed:caches:*');

    expect(mainFake.scanMatches).toEqual(['packed:caches:*']);
    expect([...cleared].sort()).toEqual([
      'packed:caches:tag-ids-for-images:7',
      'packed:caches:user-cosmetics:1',
      'packed:caches:user-cosmetics:2',
    ]);
    expect([...mainFake.deleted].sort()).toEqual([
      'packed:caches:tag-ids-for-images:7',
      'packed:caches:user-cosmetics:1',
      'packed:caches:user-cosmetics:2',
    ]);
    expect(mainFake.store.has('unrelated:thing:1')).toBe(true);
  });

  it('clearCacheByPattern still deletes an exact (glob-free) key', async () => {
    const { clearCacheByPattern } = await import('~/server/utils/cache-helpers');

    const cleared = await clearCacheByPattern('packed:caches:user-cosmetics:1');

    expect(cleared).toEqual(['packed:caches:user-cosmetics:1']);
    expect(mainFake.deleted).toEqual(['packed:caches:user-cosmetics:1']);
    expect(mainFake.store.has('packed:caches:user-cosmetics:1')).toBe(false);
    expect(mainFake.scanMatches).toEqual([]);
  });

  it("clearCacheByPatterns still scans the whole keyspace with MATCH '*'", async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns([
      'packed:caches:user-cosmetics:*',
      'unrelated:thing:*',
    ]);

    expect(mainFake.scanMatches).toEqual(['*']);
    // Positive control: the scan must have SEEN the whole keyspace, not an empty one.
    expect([...mainFake.enumerated].sort()).toEqual([...PROD_KEYS].sort());
    expect(results).toEqual([
      { pattern: 'packed:caches:user-cosmetics:*', cleared: 2 },
      { pattern: 'unrelated:thing:*', cleared: 1 },
    ]);
    expect(mainFake.store.has('packed:caches:tag-ids-for-images:7')).toBe(true);
  });

  it('clearCacheByPatterns still deletes exact keys on the no-scan fast path', async () => {
    const { clearCacheByPatterns } = await import('~/server/utils/cache-helpers');

    const results = await clearCacheByPatterns(['packed:caches:user-cosmetics:1']);

    expect(results).toEqual([{ pattern: 'packed:caches:user-cosmetics:1', cleared: 1 }]);
    expect(mainFake.deleted).toEqual(['packed:caches:user-cosmetics:1']);
    expect(mainFake.scanMatches).toEqual([]);
  });

  it('the endpoint passes the caller glob through unchanged', async () => {
    const handler = (await import('~/pages/api/admin/clear-cache-by-pattern')).default as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    const res = makeRes();

    await handler({ query: { pattern: 'packed:caches:*' } }, res);

    expect(mainFake.scanMatches).toEqual(['packed:caches:*']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, cleared: 3, target: 'main' });
  });

  it('the endpoint reports the caller patterns verbatim on the multi-pattern path', async () => {
    const handler = (await import('~/pages/api/admin/clear-cache-by-pattern')).default as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    const res = makeRes();

    await handler({ query: { patterns: 'packed:caches:user-cosmetics:*,unrelated:thing:*' } }, res);

    expect(mainFake.scanMatches).toEqual(['*']);
    expect(res.body).toEqual({
      ok: true,
      cleared: 3,
      target: 'main',
      perPattern: [
        { pattern: 'packed:caches:user-cosmetics:*', cleared: 2 },
        { pattern: 'unrelated:thing:*', cleared: 1 },
      ],
    });
  });

  it('the endpoint leaves the sys target alone and hits the sys client', async () => {
    const handler = (await import('~/pages/api/admin/clear-cache-by-pattern')).default as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    const res = makeRes();

    await handler({ query: { pattern: 'device:accounts:*', target: 'sys' } }, res);

    expect(sysFake.scanMatches).toEqual(['device:accounts:*']);
    expect(mainFake.scanMatches).toEqual([]);
    expect(mainFake.deleted).toEqual([]);
    expect(res.body).toEqual({ ok: true, cleared: 2, target: 'sys' });
  });

  it('preserves the SSE event sequence and payload shape', async () => {
    const handler = (await import('~/pages/api/admin/clear-cache-by-pattern')).default as (
      req: unknown,
      res: unknown
    ) => Promise<void>;
    const res = makeRes();

    await handler(
      { query: { patterns: 'packed:caches:user-cosmetics:*,unrelated:thing:*', stream: '1' } },
      res
    );

    const events = res.chunks
      .filter((c) => c.startsWith('event: '))
      .map((c) => {
        const [eventLine, dataLine] = c.split('\n');
        return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice(6)) };
      });

    expect(events.map((e) => e.event)).toEqual(['start', 'progress', 'done']);
    expect(events[0].data).toEqual({
      patterns: ['packed:caches:user-cosmetics:*', 'unrelated:thing:*'],
      target: 'main',
    });
    expect(events[2].data).toEqual({
      total: 3,
      perPattern: [
        { pattern: 'packed:caches:user-cosmetics:*', cleared: 2 },
        { pattern: 'unrelated:thing:*', cleared: 1 },
      ],
    });
  });
});

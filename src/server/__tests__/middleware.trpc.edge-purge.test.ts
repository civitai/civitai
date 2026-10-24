import { beforeEach, describe, expect, it, vi } from 'vitest';
import superjson from 'superjson';
import * as z from 'zod';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createLuaRedis } from '~/server/utils/__tests__/redis-lua-harness';

// `edgeCacheIt` returns early when `!isProd`.
vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

const { edgeCacheIt } = await import('~/server/middleware.trpc');
const { createCallerFactory, publicProcedure, router } = await import('~/server/trpc');
const { REDIS_KEYS } = await import('~/server/redis/client');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');

const TTL = 60;
const TAG = 'edge-purge-test';
const SET = `${REDIS_KEYS.CACHES.EDGE_CACHED}:${TAG}`;

// One in-memory Redis behind every command the cache bookkeeping can use, scripted or not.
let lua = createLuaRedis(Date.now());
const run = (script: string, keys: string[], args: string[]) =>
  lua.eval(script, { keys, arguments: args });
redisMock.redis.eval.mockImplementation(
  (script: string, opts: { keys: string[]; arguments: string[] }) => lua.eval(script, opts)
);
redisMock.redis.sAdd.mockImplementation((key: string, member: string) =>
  run("return redis.call('SADD', KEYS[1], ARGV[1])", [key], [member])
);
redisMock.redis.expire.mockImplementation((key: string, seconds: number) =>
  run("return redis.call('EXPIRE', KEYS[1], ARGV[1])", [key], [String(seconds)])
);

const testRouter = router({
  tagged: publicProcedure
    .input(z.object({ n: z.number() }).optional())
    .use(edgeCacheIt({ ttl: TTL, tags: () => [TAG] }))
    .query(() => ({ ok: true })),
  scheduled: publicProcedure
    .use(
      edgeCacheIt({ ttl: TTL, expireAt: () => new Date(Date.now() + 900_000), tags: () => [TAG] })
    )
    .query(() => ({ ok: true })),
  untagged: publicProcedure
    .input(z.object({ n: z.number() }).optional())
    .use(edgeCacheIt({ ttl: TTL }))
    .query(() => ({ ok: true })),
});
const call = createCallerFactory(testRouter);

type Cache = { edgeTTL: number; browserTTL: number; canCache: boolean; skip: boolean };
function ctx(url: string) {
  const cache: Cache = { edgeTTL: 0, browserTTL: 0, canCache: true, skip: false };
  return {
    cache,
    ctx: {
      user: undefined,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      features: { canViewNsfw: false },
      cache,
      req: { url, query: {}, headers: {} },
      res: undefined,
    } as never,
  };
}

// The URL the site's own tRPC client sends a signed-out visitor (it spreads every object input).
const canonical = (path: string, input?: object) =>
  `/api/trpc/${path}?input=${encodeURIComponent(
    JSON.stringify(superjson.serialize({ ...input }))
  )}`;

async function query(path: 'tagged' | 'untagged' | 'scheduled', url: string, n?: number) {
  const { cache, ctx: c } = ctx(url);
  await call(c)[path](n === undefined ? undefined : { n });
  return cache;
}

beforeEach(() => {
  lua = createLuaRedis(Date.now());
});

describe('edge-cache purge bookkeeping', () => {
  it('records and caches a tagged response requested the way the site requests it', async () => {
    const cache = await query('tagged', canonical('tagged', { n: 1 }), 1);
    expect(cache.edgeTTL).toBe(TTL);
    expect((await query('tagged', canonical('tagged'))).edgeTTL).toBe(TTL);
    expect(lua.set(SET)?.sort()).toEqual(
      [canonical('tagged'), canonical('tagged', { n: 1 })].sort()
    );
  });

  it('serves any other form of a tagged URL uncached and does not record it', async () => {
    for (let i = 0; i < 150; i++) {
      const cache = await query('tagged', `${canonical('tagged')}?v=${i}`);
      expect([cache.edgeTTL, cache.browserTTL]).toEqual([0, 0]);
    }
    const spaced = `/api/trpc/tagged?input=${encodeURIComponent('{ "json": { "n": 1 } }')}`;
    expect((await query('tagged', spaced, 1)).edgeTTL).toBe(0);
    // Same parsed input, but carrying a key the procedure drops.
    expect((await query('tagged', canonical('tagged', { n: 1, x: 2 }), 1)).edgeTTL).toBe(0);
    expect((await query('tagged', '/api/trpc/tagged')).edgeTTL).toBe(0);
    expect(lua.set(SET) ?? []).toHaveLength(0);
  });

  it('gives a full list with no expiry one, so it still clears', async () => {
    lua.setSet(
      SET,
      Array.from({ length: 100 }, (_, i) => `/old/${i}`)
    );
    expect((await query('tagged', canonical('tagged', { n: 1 }), 1)).edgeTTL).toBe(0);
    expect(lua.pttl(SET)).toBeGreaterThan(0);
    // Logged once per tag per process, naming the request that hit the bound.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'edge-cache-tag-cap',
        tag: TAG,
        cap: 100,
        path: 'tagged',
        url: canonical('tagged', { n: 1 }),
      }),
      'civitai-prod'
    );
    lua.nowMs += (TTL + 1) * 1000;
    expect((await query('tagged', canonical('tagged', { n: 1 }), 1)).edgeTTL).toBe(TTL);
  });

  it('never caches a tagged response for longer than its URL stays recorded', async () => {
    expect((await query('scheduled', canonical('scheduled'))).edgeTTL).toBe(TTL);
  });

  it('leaves untagged procedures as they were', async () => {
    expect((await query('untagged', `${canonical('untagged')}?v=1`)).edgeTTL).toBe(TTL);
  });

  it('stops recording at the cap, serves the rest uncached, and resumes once the list expires', async () => {
    const results: number[] = [];
    for (let i = 0; i < 150; i++)
      results.push((await query('tagged', canonical('tagged', { n: i }), i)).edgeTTL);

    expect(lua.set(SET)).toHaveLength(100);
    expect(results.slice(0, 100).every((ttl) => ttl === TTL)).toBe(true);
    expect(results.slice(100).every((ttl) => ttl === 0)).toBe(true);
    // A URL already on the list stays cacheable at the cap, but only for as long as the list
    // lives, and without extending it: a full list still expires on schedule.
    lua.nowMs += (TTL / 2) * 1000;
    const member = await query('tagged', canonical('tagged', { n: 0 }), 0);
    expect(member.edgeTTL).toBeGreaterThan(0);
    expect(member.edgeTTL).toBeLessThanOrEqual(TTL / 2);

    lua.nowMs += (TTL / 2 + 1) * 1000;
    expect((await query('tagged', canonical('tagged', { n: 500 }), 500)).edgeTTL).toBe(TTL);
    expect(lua.set(SET)).toEqual([canonical('tagged', { n: 500 })]);
  });
});

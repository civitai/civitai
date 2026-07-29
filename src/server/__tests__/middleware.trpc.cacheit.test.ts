import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fail-open contract for the `cacheIt` tRPC middleware's cache-WRITE block.
 *
 * The query has already succeeded by the time we write the cache. A Redis blip
 * while writing the value (`redis.packed.set`) or the tag set
 * (`sAddWithExpireGe` → `redis.eval`) must NEVER turn that successful response
 * into a 500 — the whole write block is wrapped in a fail-open try/catch that
 * logs `write-degraded` and returns the computed result uncached.
 *
 * We mock `~/server/trpc` so `middleware(fn)` is the identity, letting us invoke
 * the raw middleware function directly with a controlled `next`/`ctx`/`redis`.
 * `sAddWithExpireGe` (from ~/server/redis/atomic) runs for real against the
 * fake's `.eval`.
 */

// Hoisted so the (hoisted) vi.mock factories below can reference them.
const { redisFake, logSysRedisFailOpen } = vi.hoisted(() => ({
  redisFake: {
    packed: {
      get: vi.fn().mockResolvedValue(null), // cache miss → proceed to next()
      set: vi.fn().mockResolvedValue(undefined),
    },
    eval: vi.fn().mockResolvedValue(1), // backs sAddWithExpireGe (the tag write)
  },
  logSysRedisFailOpen: vi.fn(),
}));

// middleware(fn) -> fn, so cacheIt() returns the bare async middleware fn.
vi.mock('~/server/trpc', () => ({ middleware: (fn: unknown) => fn }));
// withSpan(name, fn) -> fn() (no OTel SDK in the unit env).
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
// Not exercised by cacheIt but imported at module top — stub to keep the import
// graph light and side-effect-free.
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn().mockResolvedValue({
    hiddenImages: [],
    hiddenTags: [],
    hiddenModels: [],
    hiddenUsers: [],
  }),
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

vi.mock('~/server/redis/client', () => ({
  redis: redisFake,
  REDIS_KEYS: {
    TRPC: { BASE: 'packed:trpc' },
    CACHES: { TAGGED_CACHE: 'caches:tagged-cache' },
  },
}));

import { cacheIt } from '~/server/middleware.trpc';

type Input = { id: number };

function invoke(next: ReturnType<typeof vi.fn>) {
  const ctx = { cache: { canCache: true }, user: undefined };
  const mw = cacheIt<Input>({ ttl: 100, tags: (i) => [`tag-${i.id}`] }) as unknown as (opts: {
    input: Input;
    ctx: typeof ctx;
    next: typeof next;
    path: string;
  }) => Promise<unknown>;
  return mw({ input: { id: 1 }, ctx, next, path: 'test.proc' });
}

const COMPUTED = { ok: true, data: { foo: 'bar' }, marker: undefined, ctx: {} };

beforeEach(() => {
  vi.clearAllMocks();
  redisFake.packed.get.mockResolvedValue(null);
  redisFake.packed.set.mockResolvedValue(undefined);
  redisFake.eval.mockResolvedValue(1);
});

describe('cacheIt cache-write fail-open', () => {
  it('a Redis throw during the TAG write does not reject — returns the computed result', async () => {
    redisFake.eval.mockRejectedValue(new Error('redis cluster down'));
    const next = vi.fn().mockResolvedValue(COMPUTED);

    const result = await invoke(next); // must NOT throw

    expect(result).toBe(COMPUTED); // successful query still returned
    expect(next).toHaveBeenCalledTimes(1);
    expect(redisFake.eval).toHaveBeenCalled(); // the failing tag write was attempted
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'write-degraded',
      'middleware.trpc.cacheIt',
      expect.any(Error),
      expect.objectContaining({ path: 'test.proc' })
    );
  });

  it('a Redis throw during the VALUE set does not reject — returns the computed result', async () => {
    redisFake.packed.set.mockRejectedValue(new Error('set failed'));
    const next = vi.fn().mockResolvedValue(COMPUTED);

    const result = await invoke(next);

    expect(result).toBe(COMPUTED);
    expect(logSysRedisFailOpen).toHaveBeenCalledTimes(1);
    // The tag write never runs once the value set throws.
    expect(redisFake.eval).not.toHaveBeenCalled();
  });

  it('healthy path caches and does NOT log a fail-open', async () => {
    const next = vi.fn().mockResolvedValue(COMPUTED);

    const result = await invoke(next);

    expect(result).toBe(COMPUTED);
    expect(redisFake.packed.set).toHaveBeenCalledTimes(1);
    expect(redisFake.eval).toHaveBeenCalledTimes(1); // one tag → one eval
    expect(logSysRedisFailOpen).not.toHaveBeenCalled();
  });
});

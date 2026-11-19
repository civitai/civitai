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
const { logSysRedisFailOpen } = vi.hoisted(() => ({
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
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn().mockResolvedValue({
    hiddenImages: [],
    hiddenTags: [],
    hiddenModels: [],
    hiddenUsers: [],
  }),
}));

vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen }));

import { cacheIt } from '~/server/middleware.trpc';
import { cacheItKeyHash } from '~/server/utils/query-cache-key';
import { hashifyObject } from '~/utils/string-helpers';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const redisFake = redisMock.redis;
redisMock.redis.packed.set.mockResolvedValue(undefined);
redisMock.redis.eval.mockResolvedValue(1);

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

/**
 * Cache-key composition — the mechanism only. These pass their own options in, so
 * they cannot see any one procedure's configuration; `tag.router.cache-key.test.ts`
 * covers that call site against the real router.
 */
type KeyInput = {
  excludedTagIds?: number[];
  excludedImageIds?: number[];
  excludedUserIds?: number[];
  excludedModelIds?: number[];
};

async function keyFor(input?: KeyInput, adminTags?: boolean) {
  const mw = cacheIt<KeyInput>({
    ttl: 60,
    excludeKeys: ['excludedImageIds', 'excludedUserIds', 'excludedModelIds'],
    varyBy: (ctx) => ({ adminTags: ctx.features.adminTags }),
  }) as unknown as (opts: {
    input?: KeyInput;
    ctx: unknown;
    next: () => unknown;
    path: string;
  }) => Promise<unknown>;

  await mw({
    input,
    ctx: { cache: { canCache: true }, user: undefined, features: { adminTags } },
    next: vi.fn().mockResolvedValue(COMPUTED),
    path: 'tag.getAll',
  });

  return redisFake.packed.get.mock.calls.at(-1)![0] as string;
}

describe('cacheIt cache-key composition', () => {
  it.each(['excludedImageIds', 'excludedUserIds', 'excludedModelIds'] as const)(
    'the key does NOT move when %s changes',
    async (field) => {
      const base = await keyFor({ excludedTagIds: [7] });
      const withField = await keyFor({ excludedTagIds: [7], [field]: [1, 2, 3] });

      expect(withField).toBe(base);
    }
  );

  it('the key DOES move when excludedTagIds changes', async () => {
    const a = await keyFor({ excludedTagIds: [7] });
    const b = await keyFor({ excludedTagIds: [7, 8] });

    expect(b).not.toBe(a);
  });

  it('the key DOES move with adminTags — the response drops the adminOnly filter on it', async () => {
    const asAdmin = await keyFor({ excludedTagIds: [7] }, true);
    const asAnon = await keyFor({ excludedTagIds: [7] }, undefined);

    expect(asAdmin).not.toBe(asAnon);
  });

  it('refuses an input key that collides with a varyBy dimension', async () => {
    await expect(
      keyFor({ excludedTagIds: [7], ...({ adminTags: true } as object) })
    ).rejects.toThrow(/collides with an input key/);
  });

  // The collision is with the INPUT, not with what survived into the key — these
  // three inputs all contribute nothing to it and would otherwise be overwritten
  // in silence.
  it.each([
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['undefined', undefined],
  ])('refuses a colliding input key whose value is %s', async (_label, value) => {
    await expect(
      keyFor({ excludedTagIds: [7], ...({ adminTags: value } as object) })
    ).rejects.toThrow(/collides with an input key/);
  });

  it('refuses a colliding input key that is itself excluded from the key', async () => {
    const mw = cacheIt<KeyInput>({
      ttl: 60,
      excludeKeys: ['excludedModelIds'],
      varyBy: () => ({ excludedModelIds: [1] }),
    }) as unknown as (opts: {
      input?: unknown;
      ctx: unknown;
      next: () => unknown;
      path: string;
    }) => Promise<unknown>;

    await expect(
      mw({
        input: { excludedModelIds: [2] },
        ctx: { cache: { canCache: true }, user: undefined, features: {} },
        next: vi.fn().mockResolvedValue(COMPUTED),
        path: 'tag.getAll',
      })
    ).rejects.toThrow(/collides with an input key/);
  });

  it('does not mistake an inherited property for a collision', async () => {
    const mw = cacheIt<KeyInput>({
      ttl: 60,
      varyBy: () => ({ toString: 'x', constructor: 'y', valueOf: 'z' }),
    }) as unknown as (opts: {
      input?: unknown;
      ctx: unknown;
      next: () => unknown;
      path: string;
    }) => Promise<unknown>;

    await expect(
      mw({
        input: { excludedTagIds: [7] },
        ctx: { cache: { canCache: true }, user: undefined, features: {} },
        next: vi.fn().mockResolvedValue(COMPUTED),
        path: 'tag.getAll',
      })
    ).resolves.toBeDefined();
  });

  it('array order and duplicates do not move the key', async () => {
    const a = await keyFor({ excludedTagIds: [7, 8] });
    const b = await keyFor({ excludedTagIds: [8, 7, 7, 8] });

    expect(b).toBe(a);
  });

  it('does not mutate the caller input array', async () => {
    const excludedTagIds = [9, 3, 9];
    await keyFor({ excludedTagIds });

    expect(excludedTagIds).toEqual([9, 3, 9]);
  });
});

/**
 * The key's hash segment. `model.getAllPagedSimple` varies its key on `isModerator`, so two
 * callers whose values hash alike would read each other's cached response.
 */
type QueryInput = { query?: string; limit?: number; allowDerivatives?: boolean };

function invokeAs(isModerator: boolean, input: QueryInput, next: ReturnType<typeof vi.fn>) {
  const mw = cacheIt<QueryInput>({
    ttl: 60,
    varyBy: (ctx) => ({ isModerator: ctx.user?.isModerator ?? false }),
  }) as unknown as (opts: {
    input: QueryInput;
    ctx: unknown;
    next: typeof next;
    path: string;
  }) => Promise<{ data: unknown }>;
  return mw({
    input,
    ctx: { cache: { canCache: true }, user: isModerator ? { id: 1, isModerator } : undefined },
    next,
    path: 'model.getAllPagedSimple',
  });
}

describe('cacheIt key hash', () => {
  // A real 32-bit `hashifyObject` collision, found by brute force over search-like strings.
  const MOD_QUERY = 'night robot 4yi';
  const PUBLIC_QUERY = 'ocean dragon 5ud';

  beforeEach(() => {
    const store = new Map<string, unknown>();
    redisFake.packed.get.mockImplementation(async (k: string) => store.get(k) ?? null);
    redisFake.packed.set.mockImplementation(async (k: string, v: unknown) => {
      store.set(k, v);
    });
  });

  it('a non-moderator never reads a moderator response whose key collided under the old hash', async () => {
    expect(hashifyObject({ query: MOD_QUERY, isModerator: true })).toBe(
      hashifyObject({ query: PUBLIC_QUERY, isModerator: false })
    );
    const modNext = vi.fn().mockResolvedValue({ ok: true, data: 'moderator rows', ctx: {} });
    await invokeAs(true, { query: MOD_QUERY }, modNext);

    const publicNext = vi.fn().mockResolvedValue({ ok: true, data: 'public rows', ctx: {} });
    const result = await invokeAs(false, { query: PUBLIC_QUERY }, publicNext);

    expect(publicNext).toHaveBeenCalledTimes(1);
    expect(result.data).toBe('public rows');
  });

  it('moderator and non-moderator never share a key for the same input', async () => {
    for (const input of [{}, { query: MOD_QUERY }, { query: 'x', limit: 20 }]) {
      redisFake.packed.get.mockClear();
      await invokeAs(true, input, vi.fn().mockResolvedValue(COMPUTED));
      await invokeAs(false, input, vi.fn().mockResolvedValue(COMPUTED));
      const [modKey, publicKey] = redisFake.packed.get.mock.calls.map(([k]) => k);
      expect(modKey).not.toBe(publicKey);
    }
  });

  it('the same values in another key order share a key', async () => {
    const next = vi.fn().mockResolvedValue(COMPUTED);
    await invokeAs(false, { query: 'cat', limit: 20 }, next);
    await invokeAs(false, { limit: 20, query: 'cat' }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['false', { allowDerivatives: false }],
    ['zero', { limit: 0 }],
    ['an empty string', { query: '' }],
  ])('an input value of %s does not share the key of an omitted one', async (_, input) => {
    const next = vi.fn().mockResolvedValue(COMPUTED);
    await invokeAs(false, {}, next);
    await invokeAs(false, input, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('refuses to key on a Set or Map, which would hash alike whatever they hold', () => {
    expect(() => cacheItKeyHash({ ids: new Set([1]) })).toThrow(/Set/);
    expect(() => cacheItKeyHash({ ids: new Map([[1, 1]]) })).toThrow(/Map/);
  });

  it('values JSON writes alike get different hashes', () => {
    expect(cacheItKeyHash({ id: BigInt(1) })).not.toBe(cacheItKeyHash({ id: '1' }));
    expect(cacheItKeyHash({ id: BigInt(1) })).not.toBe(cacheItKeyHash({ id: 1 }));
    const at = new Date('2026-01-01T00:00:00.000Z');
    expect(cacheItKeyHash({ at })).not.toBe(cacheItKeyHash({ at: at.toISOString() }));
  });
});

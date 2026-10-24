import { beforeEach, describe, expect, it, vi } from 'vitest';

// `edgeCacheIt` returns early when `!isProd`, so the TTL-assigning block only runs
// with this mocked true. Same shape as `middleware.trpc.test.ts`.
vi.mock('~/env/other', () => ({
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));

// `setup.ts` mocks `~/env/server` globally but NOT `~/env/client`, which validates the
// client schema at module load and THROWS on a miss. Importing the real router reaches it
// through the service's import graph. A miss fails the whole FILE as a suite-level error
// with ZERO failing tests, so pin it here rather than depend on ambient env. Same shape as
// `src/server/__tests__/middleware.trpc.rate-limit-key.test.ts`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

// tRPC's `_def.middlewares` ends with the wrapper that invokes the resolver, so running
// the real chain runs the real handler. Stub only the service calls it makes so the chain
// completes without a database — the subject here is middleware ordering and context
// propagation, not the query.
import type * as LeaderboardService from '~/server/services/leaderboard.service';

const { getLeaderboard, getLeaderboardLegends } = vi.hoisted(() => ({
  getLeaderboard: vi.fn(),
  getLeaderboardLegends: vi.fn(),
}));

vi.mock('~/server/services/leaderboard.service', async (importOriginal) => ({
  ...(await importOriginal<typeof LeaderboardService>()),
  getLeaderboard,
  getLeaderboardLegends,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { leaderboardRouter } from '~/server/routers/leaderboard.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `leaderboard.getLeaderboard`'s middleware chain, run in order, asserting the values
 * `responseMeta` (`src/pages/api/trpc/[trpc].ts`) reads off the context when it is done.
 *
 * The subject is a relationship no single-surface test can see. `getLeaderboard` in
 * `leaderboard.service.ts` drops its `AND l.public = true` predicate for a moderator, so
 * the response body is identity-dependent; `edgeCacheIt` caches per-URL and therefore
 * must not run for that one caller shape. Nothing about either half alone pins that they
 * agree.
 *
 * Three properties this pins that an isolated test cannot:
 *
 * 1. **`edgeCacheIt` writes the ROOT context on this chain.** tRPC's `next({ ctx })`
 *    builds a new object (`{ ...opts.ctx, ...nextOpts.ctx }`) but hands `responseMeta`
 *    the ROOT (`ctxManager.valueOrUndefined()`). No middleware here replaces `ctx.cache`
 *    for a non-moderator, so `edgeCacheIt`'s `ctx.cache.edgeTTL = reqTTL` lands on the
 *    same object the header is built from. That is what makes the anonymous and
 *    non-moderator arms below real cacheability assertions rather than vacuous ones.
 * 2. **Order is load-bearing.** `edgeCacheIt` reads `ctx.cache.skip` to compute the TTL
 *    BEFORE calling `next()`, so the opt-out only works UPSTREAM of it. Swapping the two
 *    `.use()` calls makes the guard inert in production — and leaves a middleware-only
 *    or resolver-only test green, because neither runs the chain.
 * 3. **The opt-out COPIES `ctx.cache` instead of mutating it.** `ctx.cache` is
 *    request-scoped and shared by every procedure resolved from the same request, so an
 *    in-place `skip = true` escapes this procedure.
 *
 * SENTINEL root TTLs are what keep the assertions non-vacuous: `edgeCacheIt`'s ttl here
 * is `CacheTTL.xs` = 60, which is byte-identical to `createContext`'s ANONYMOUS default
 * (also 60), so with production values "wrote the TTL" and "left the default alone" are
 * the same observation. Tests that need production semantics ask for them explicitly.
 */
type Ctx = {
  user?: { id: number; isModerator?: boolean };
  // `isAcceptableOrigin` (src/server/trpc.ts) runs ahead of these middlewares on every
  // publicProcedure and throws UNAUTHORIZED without it, so the chain would never reach
  // the cache middlewares. It is also why an error response can never carry a cache
  // header: `responseMeta` only sets one when `errors.length === 0`.
  acceptableOrigin: boolean;
  // `enforceTokenScope` runs ahead of the cache middlewares too.
  tokenScope: number;
  cache: {
    browserTTL: number;
    edgeTTL: number;
    staleWhileRevalidate: number;
    canCache: boolean;
    skip: boolean;
  };
  features: Record<string, boolean>;
};

type Middleware = (opts: {
  input?: unknown;
  ctx: Ctx;
  next: (opts?: { ctx?: Partial<Ctx> }) => unknown;
  path: string;
  // tRPC's own input-parsing middleware is part of this chain and calls it.
  getRawInput: () => Promise<unknown>;
  type: string;
}) => Promise<unknown>;

/**
 * Deliberately not 0, not 60 (`CacheTTL.xs`, the value `edgeCacheIt` writes here, and
 * also `createContext`'s anonymous default), not 30 (`staleWhileRevalidate`'s written
 * value) and not equal to each other — so every assertion below can tell "the middleware
 * wrote this" from "the incoming value survived".
 */
const SENTINEL = { browserTTL: 111, edgeTTL: 222, staleWhileRevalidate: 333 };

/** The value `edgeCacheIt({ ttl: CacheTTL.xs })` writes when it does NOT skip. */
const EDGE_TTL_WHEN_CACHED = 60;

/** What `createContext` builds for each caller shape (src/server/createContext.ts). */
const PROD_DEFAULTS = {
  anonymous: { browserTTL: 60, edgeTTL: 60, staleWhileRevalidate: 30 },
  authenticated: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0 },
};

const procedures = (
  leaderboardRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures;

function rootCtx(
  user: Ctx['user'] | undefined,
  ttls: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number }
): Ctx {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { ...ttls, canCache: true, skip: false },
    features: {},
  };
}

/**
 * Run a whole procedure chain, replicating tRPC's context merge exactly:
 *   ctx = nextOpts?.ctx ? { ...opts.ctx, ...nextOpts.ctx } : opts.ctx
 * Returns the ROOT context (what `responseMeta` is handed), plus the downstream context
 * carrying the COPIED cache object when the opt-out made one.
 */
async function runChain(opts: {
  procedure?: 'getLeaderboard' | 'getLeadboardLegends';
  user?: Ctx['user'];
  ttls?: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number };
}) {
  const middlewares = procedures[opts.procedure ?? 'getLeaderboard']._def.middlewares;
  const root = rootCtx(opts.user, opts.ttls ?? SENTINEL);
  const input = { id: 'overall', maxPosition: 100 };
  const seen: Ctx[] = [];
  let i = 0;

  const step = async (ctx: Ctx): Promise<unknown> => {
    seen.push(ctx);
    if (i >= middlewares.length) return { ok: true, data: {}, marker: undefined, ctx };
    const mw = middlewares[i++];
    return mw({
      input,
      ctx,
      path: `leaderboard.${opts.procedure ?? 'getLeaderboard'}`,
      getRawInput: async () => input,
      type: 'query',
      next: (nextOpts?: { ctx?: Partial<Ctx> }) =>
        step(nextOpts?.ctx ? ({ ...ctx, ...nextOpts.ctx } as Ctx) : ctx),
    });
  };

  const result = (await step(root)) as { ok?: boolean };
  // Identified by REFERENCE, not by position, so this keeps working if the chain gains a
  // middleware. It is the object `edgeCacheIt` writes to once the opt-out has run.
  const downstream = seen.find((c) => c.cache !== root.cache);
  return { root, downstream, result };
}

/** `responseMeta`'s own predicate, src/pages/api/trpc/[trpc].ts. */
const willEdgeCache = (ctx: Ctx) => !!ctx.cache && !!ctx.cache.edgeTTL && ctx.cache.edgeTTL > 0;

beforeEach(() => {
  vi.clearAllMocks();
  getLeaderboard.mockResolvedValue([]);
  getLeaderboardLegends.mockResolvedValue([]);
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

describe('leaderboard.getLeaderboard edge-cache chain', () => {
  describe('moderator — the one caller shape whose body differs', () => {
    it('leaves the edge TTL the header is built from at zero (production defaults)', async () => {
      const { root } = await runChain({
        user: { id: 1, isModerator: true },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(0);
      expect(willEdgeCache(root)).toBe(false);
    });

    // The assertion above uses the production authenticated defaults, where "0 survived"
    // and "0 was written" are the same observation. From a SENTINEL root, the middleware
    // ttl (60) is the only value that can appear if the opt-out fails — so this is what
    // discriminates a working guard from an absent one.
    it('leaves the root cache object untouched, so the middleware ttl never reaches it', async () => {
      const { root } = await runChain({ user: { id: 1, isModerator: true } });

      expect(root.cache.edgeTTL).toBe(SENTINEL.edgeTTL);
      expect(root.cache.edgeTTL).not.toBe(EDGE_TTL_WHEN_CACHED);
      expect(root.cache.browserTTL).toBe(SENTINEL.browserTTL);
      expect(root.cache.staleWhileRevalidate).toBe(SENTINEL.staleWhileRevalidate);
    });

    // Property 3: the opt-out must not mutate the request-scoped cache object, which is
    // shared with every other procedure resolved from the same request.
    it('does not mutate the shared request-scoped cache object', async () => {
      const { root, downstream } = await runChain({ user: { id: 1, isModerator: true } });

      expect(root.cache.skip).toBe(false);
      expect(downstream).toBeDefined();
      expect(downstream?.cache).not.toBe(root.cache);
      expect(downstream?.cache.skip).toBe(true);
    });

    // Positive control for the three assertions above: without it, "the root was not
    // written" would also pass if `edgeCacheIt` were absent, inert, or never reached.
    it('still reaches a live edgeCacheIt, which computes a zero TTL downstream', async () => {
      const { downstream } = await runChain({ user: { id: 1, isModerator: true } });

      expect(downstream?.cache.edgeTTL).toBe(0);
      expect(downstream?.cache.staleWhileRevalidate).toBe(30);
    });
  });

  describe('callers whose body is the public variant — must STAY edge-cacheable', () => {
    // Positive control AND the regression that a `ctx.user`-shaped predicate would cause:
    // an ordinary authenticated non-moderator gets the same `public = true` body an
    // anonymous caller gets, so excluding them would cost the cache and buy nothing.
    it('writes the middleware ttl to the root for an authenticated NON-moderator', async () => {
      const { root, downstream } = await runChain({
        user: { id: 1, isModerator: false },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(EDGE_TTL_WHEN_CACHED);
      expect(willEdgeCache(root)).toBe(true);
      // No copy was made, so the write reached the root directly.
      expect(downstream).toBeUndefined();
    });

    it('writes the middleware ttl to the root for a user with no isModerator field', async () => {
      const { root } = await runChain({
        user: { id: 1 },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(EDGE_TTL_WHEN_CACHED);
      expect(willEdgeCache(root)).toBe(true);
    });

    it('writes the middleware ttl to the root for an anonymous caller', async () => {
      const { root, downstream } = await runChain({});

      // From a SENTINEL root this can only have been written by `edgeCacheIt`.
      expect(root.cache.edgeTTL).toBe(EDGE_TTL_WHEN_CACHED);
      expect(root.cache.edgeTTL).not.toBe(SENTINEL.edgeTTL);
      expect(willEdgeCache(root)).toBe(true);
      expect(downstream).toBeUndefined();
    });

    it('keeps an anonymous caller cacheable under production defaults too', async () => {
      const { root } = await runChain({ ttls: PROD_DEFAULTS.anonymous });

      expect(root.cache.edgeTTL).toBe(EDGE_TTL_WHEN_CACHED);
      expect(willEdgeCache(root)).toBe(true);
    });
  });

  it('leaves the chain succeeding for a moderator — the opt-out is not an error path', async () => {
    const { result } = await runChain({ user: { id: 1, isModerator: true } });

    expect(result.ok).toBe(true);
    expect(getLeaderboard).toHaveBeenCalledTimes(1);
    expect(getLeaderboard).toHaveBeenCalledWith(expect.objectContaining({ isModerator: true }));
  });
});

describe('leaderboard.getLeadboardLegends — shares the edge-cache instance, needs no opt-out', () => {
  // `getLeaderboardLegends` is handed an `isModerator` but never reads it: its query
  // filters on `leaderboardId` and domain only, with no `public` predicate. Every caller
  // gets the same body, so it stays edge-cacheable for moderators too. Pinning this keeps
  // the asymmetry with `getLeaderboard` deliberate rather than accidental.
  it('stays edge-cacheable for a moderator', async () => {
    const { root } = await runChain({
      procedure: 'getLeadboardLegends',
      user: { id: 1, isModerator: true },
      ttls: PROD_DEFAULTS.authenticated,
    });

    expect(root.cache.edgeTTL).toBe(EDGE_TTL_WHEN_CACHED);
    expect(willEdgeCache(root)).toBe(true);
  });

  // The behavioural half of the claim above: the service ignores the flag it is handed,
  // which is WHY the procedure needs no opt-out. If this ever stops holding, the comment
  // in the router stops being true and the opt-out has to be extended.
  it('receives isModerator but its service is the identity-independent one', async () => {
    await runChain({
      procedure: 'getLeadboardLegends',
      user: { id: 1, isModerator: true },
    });

    expect(getLeaderboardLegends).toHaveBeenCalledTimes(1);
    expect(getLeaderboard).not.toHaveBeenCalled();
  });
});

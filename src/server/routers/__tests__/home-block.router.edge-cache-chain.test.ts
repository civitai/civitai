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
// client schema at module load and THROWS on a miss. Importing the real router reaches
// it through the controller's import graph. A miss fails the whole FILE as a suite-level
// error with zero failing tests, so pin it here rather than depend on ambient env. Same
// shape as `middleware.trpc.rate-limit-key.test.ts`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

// tRPC's `_def.middlewares` ends with the wrapper that invokes the resolver, so running
// the real chain runs the real handler — which is the point: the flag under test is set
// by the handler. Stub only the one service call it makes so the chain completes without
// a database.
import type * as HomeBlockService from '~/server/services/home-block.service';

const { getHomeBlockById } = vi.hoisted(() => ({ getHomeBlockById: vi.fn() }));

vi.mock('~/server/services/home-block.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockService>()),
  getHomeBlockById,
}));

import { homeBlockRouter } from '~/server/routers/home-block.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `homeBlock.getHomeBlock`'s middleware chain, run in order, asserting the values
 * `responseMeta` reads off the context when the chain is done.
 *
 * The subject is a cross-file relationship no single-surface test can see:
 * `home-block.controller` sets `ctx.cache.skip = true` for an Announcement block from
 * INSIDE the resolver, and `edgeCacheIt` (`src/server/middleware.trpc.ts`) is the only
 * thing that reads it. A test of either half alone passes whether or not the write ever
 * reaches the read.
 *
 * Two properties this pins that an isolated test cannot:
 *
 * 1. **`edgeCacheIt` writes the ROOT context here.** Unlike `model.getAll`, nothing in
 *    this chain replaces `ctx.cache` with a copy, so the middleware's assignments land
 *    on the same object `responseMeta` is handed
 *    (`ctxManager.valueOrUndefined()` in `src/pages/api/trpc/[trpc].ts`). That is what
 *    makes the resolver's write observable at the wire at all.
 * 2. **Where the read sits relative to `await next()` is load-bearing.** The resolver
 *    cannot know it is returning an Announcement until it has run, so a `skip` read
 *    taken before `next()` can only ever see the incoming value. Moving the read back
 *    above `next()` makes the guard inert again — and leaves a middleware-only test
 *    green, because that test never runs the resolver.
 *
 * A SENTINEL root TTL is what keeps the assertions non-vacuous: `edgeCacheIt`'s own ttl
 * for this procedure (60) is byte-identical to the anonymous context default (60), so
 * with production values "wrote the TTL" and "left the default alone" are the same
 * observation. Tests that need the production defaults ask for them explicitly.
 */
type Ctx = {
  user?: { id: number; isModerator?: boolean };
  // `isAcceptableOrigin` (src/server/trpc.ts) runs ahead of these middlewares on every
  // publicProcedure and throws UNAUTHORIZED without it, so the chain never reaches the
  // cache middleware at all. It is also why an error response can never carry a cache
  // header: `responseMeta` only sets one when `errors.length === 0`.
  acceptableOrigin: boolean;
  // `enforceTokenScope` runs ahead of the cache middleware too.
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

const PATH = 'homeBlock.getHomeBlock';

/**
 * Deliberately not 60, not 0, and not equal to each other, so every assertion below can
 * tell "the middleware wrote this" from "the context default survived".
 */
const SENTINEL = { browserTTL: 111, edgeTTL: 222, staleWhileRevalidate: 333 };

/** What `createContext` builds for each caller shape (src/server/createContext.ts). */
const PROD_DEFAULTS = {
  anonymous: { browserTTL: 60, edgeTTL: 60, staleWhileRevalidate: 30 },
  authenticated: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0 },
};

const middlewares = (
  homeBlockRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures.getHomeBlock._def.middlewares;

function rootCtx(
  user: Ctx['user'] | undefined,
  ttls: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number }
): Ctx {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { ...ttls, canCache: true, skip: false },
    // `getHomeBlock` is behind `isFlagProtected('alternateHome')`, which throws FORBIDDEN
    // without it and would end the chain before `edgeCacheIt`.
    features: { alternateHome: true },
  };
}

/**
 * Run the whole chain, replicating tRPC's context merge exactly:
 *   ctx = nextOpts?.ctx ? { ...opts.ctx, ...nextOpts.ctx } : opts.ctx
 * Returns the root context — the one `responseMeta` is handed.
 */
async function runChain(opts: {
  user?: Ctx['user'];
  ttls?: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number };
}) {
  const root = rootCtx(opts.user, opts.ttls ?? SENTINEL);
  const input = { id: 7 };
  let i = 0;

  const step = async (ctx: Ctx): Promise<unknown> => {
    if (i >= middlewares.length) return { ok: true, data: {}, marker: undefined, ctx };
    const mw = middlewares[i++];
    return mw({
      input,
      ctx,
      path: PATH,
      getRawInput: async () => input,
      type: 'query',
      next: (nextOpts?: { ctx?: Partial<Ctx> }) =>
        step(nextOpts?.ctx ? ({ ...ctx, ...nextOpts.ctx } as Ctx) : ctx),
    });
  };

  const result = (await step(root)) as { ok?: boolean };
  return { root, result };
}

/** `responseMeta`'s own predicate, src/pages/api/trpc/[trpc].ts. */
const willEdgeCache = (ctx: Ctx) => !!ctx.cache && !!ctx.cache.edgeTTL && ctx.cache.edgeTTL > 0;

const announcement = { id: 7, type: 'Announcement', metadata: {} };
const collection = { id: 7, type: 'Collection', metadata: {} };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('homeBlock.getHomeBlock edge-cache chain', () => {
  describe('Announcement block — the resolver opts out', () => {
    it('zeroes the edge TTL the response header is built from (anonymous)', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await runChain({ ttls: PROD_DEFAULTS.anonymous });

      expect(root.cache.edgeTTL).toBe(0);
      expect(willEdgeCache(root)).toBe(false);
    });

    it('zeroes the edge TTL for an authenticated caller too', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await runChain({
        user: { id: 1 },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(0);
      expect(willEdgeCache(root)).toBe(false);
    });

    // The two assertions above use the production defaults, where "wrote 0" and "the
    // anonymous default was never overwritten" are distinguishable only for the
    // authenticated arm. From a sentinel root, 0 can ONLY have been written.
    it('WRITES the zero rather than leaving the incoming TTL alone', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await runChain({});

      expect(root.cache.edgeTTL).toBe(0);
      expect(root.cache.browserTTL).toBe(0);
    });

    // Discriminates this fix from a `canCache = false`-shaped one: that route skips the
    // whole assignment block, so the sentinel would survive on every field. Here the
    // block runs and only the TTLs are zero.
    it('still runs the cache-assignment block (staleWhileRevalidate is written)', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await runChain({});

      expect(root.cache.staleWhileRevalidate).toBe(30);
      expect(root.cache.staleWhileRevalidate).not.toBe(SENTINEL.staleWhileRevalidate);
    });
  });

  describe('non-Announcement block — unchanged, still edge-cached', () => {
    // Positive control for every assertion above: without these, "edgeTTL is 0" would
    // also pass with `edgeCacheIt` absent, inert, or never reached.
    it('writes the middleware ttl for an anonymous caller', async () => {
      getHomeBlockById.mockResolvedValue(collection);

      const { root } = await runChain({});

      expect(root.cache.edgeTTL).toBe(60);
      expect(root.cache.browserTTL).toBe(60);
      expect(willEdgeCache(root)).toBe(true);
    });

    it('writes the middleware ttl for an authenticated caller', async () => {
      getHomeBlockById.mockResolvedValue(collection);

      const { root } = await runChain({
        user: { id: 1 },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(60);
      expect(willEdgeCache(root)).toBe(true);
    });
  });

  it('leaves the chain succeeding — the opt-out is not an error path', async () => {
    getHomeBlockById.mockResolvedValue(announcement);

    const { result } = await runChain({});

    expect(result.ok).toBe(true);
    expect(getHomeBlockById).toHaveBeenCalledTimes(1);
  });
});

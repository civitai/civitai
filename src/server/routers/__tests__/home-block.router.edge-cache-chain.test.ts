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

// The real caller runs the real handler — which is the point: the flag under test is set
// by the handler. Stub only the one service call it makes so the chain completes without
// a database.
import type * as HomeBlockService from '~/server/services/home-block.service';

const { getHomeBlockById } = vi.hoisted(() => ({ getHomeBlockById: vi.fn() }));

vi.mock('~/server/services/home-block.service', async (importOriginal) => ({
  ...(await importOriginal<typeof HomeBlockService>()),
  getHomeBlockById,
}));

import type { Context } from '~/server/createContext';
import { homeBlockRouter } from '~/server/routers/home-block.router';
import { createCallerFactory } from '~/server/trpc';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * `homeBlock.getHomeBlock` driven through the REAL tRPC caller, asserting the values
 * `responseMeta` reads off the context when the call is done.
 *
 * The subject is a cross-file relationship no single-surface test can see:
 * `home-block.controller` sets `ctx.cache.skip = true` for an Announcement block from
 * INSIDE the resolver, and `edgeCacheIt` (`src/server/middleware.trpc.ts`) is the only
 * thing that reads it. A test of either half alone passes whether or not the write ever
 * reaches the read.
 *
 * ── WHY `createCallerFactory` AND NOT A HAND-ROLLED RUNNER ──────────────────────────────
 * An earlier revision of this file walked `_def.middlewares` itself and re-implemented
 * tRPC's context merge. That reconstruction was faithful when it was written and still
 * wrong in two ways that mattered: it forwarded the RAW input rather than the parsed one
 * (so zod's output never reached the resolver), and it had no per-middleware try/catch
 * (so it could not produce the `{ ok: false }` result the real runner produces). Both are
 * gone here, and more to the point a future `@trpc/server` upgrade can no longer silently
 * invalidate the test by changing a runner this file was pretending to be.
 *
 * Two properties this pins that an isolated test cannot:
 *
 * 1. **`edgeCacheIt` writes the ROOT context here.** Unlike `model.getAll`, nothing in
 *    this chain replaces `ctx.cache` with a copy, so the middleware's assignments land on
 *    the same object `responseMeta` is handed (`ctxManager.valueOrUndefined()` in
 *    `src/pages/api/trpc/[trpc].ts`). Driving the real caller demonstrates that directly:
 *    the context asserted below is the very object handed to `createCaller`, and tRPC's
 *    own per-middleware `{ ...ctx, ...next.ctx }` shallow merge is what keeps `cache`
 *    shared across the copies.
 * 2. **Where the read sits relative to `await next()` is load-bearing.** The resolver
 *    cannot know it is returning an Announcement until it has run, so a `skip` read taken
 *    before `next()` can only ever see the incoming value. Moving the read back above
 *    `next()` makes the guard inert again — and leaves a middleware-only test green,
 *    because that test never runs the resolver.
 *
 * The cache verdict is asserted through `willEdgeCache`, IMPORTED from
 * `~/server/trpc/edge-cache-headers` — the same function `responseMeta` calls. It used to
 * be re-declared here, which made it a guard that agreed with its own copy while the real
 * predicate could be changed underneath it.
 *
 * A SENTINEL root TTL is what keeps the assertions non-vacuous: `edgeCacheIt`'s own ttl
 * for this procedure (60) is byte-identical to the anonymous context default (60), so
 * with production values "wrote the TTL" and "left the default alone" are the same
 * observation. Tests that need the production defaults ask for them explicitly.
 */
type CacheState = {
  browserTTL: number;
  edgeTTL: number;
  staleWhileRevalidate: number;
  canCache: boolean;
  skip: boolean;
};

type Ctx = {
  user?: { id: number; isModerator?: boolean };
  // `isAcceptableOrigin` (src/server/trpc.ts) runs ahead of these middlewares on every
  // publicProcedure and throws UNAUTHORIZED without it, so the chain never reaches the
  // cache middleware at all. It is also why an error response can never carry a cache
  // header: `responseMeta` only sets one when `errors.length === 0`.
  acceptableOrigin: boolean;
  // `enforceTokenScope` runs ahead of the cache middleware too.
  tokenScope: number;
  cache: CacheState;
  // Read by `applyDomainFeature` (src/server/trpc.ts) as `ctx.features.canViewNsfw`,
  // ahead of the cache middleware. Omitting it is not "a permissive default" — it is a
  // TypeError that ends the call before `edgeCacheIt` runs.
  features: { canViewNsfw: boolean };
};

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

const createCaller = createCallerFactory(homeBlockRouter);

function rootCtx(
  user: Ctx['user'] | undefined,
  ttls: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number }
): Ctx {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { ...ttls, canCache: true, skip: false },
    // ⚠️ `canViewNsfw`, NOT `alternateHome`. An earlier revision of this file set
    // `features: { alternateHome: true }` and documented it as what satisfies
    // `isFlagProtected('alternateHome')`. That was wrong in both directions, and only
    // measuring it showed so: `isFlagProtected` resolves the flag through
    // `getFeatureFlags(ctx)` (`~/server/services/feature-flags.service.ts`), which
    // computes from the session/Flipt and never reads a `ctx.features` property — so the
    // key was INERT, and setting it to `false` does NOT produce a FORBIDDEN. What
    // `ctx.features` is actually needed for is `applyDomainFeature`, which dereferences
    // `ctx.features.canViewNsfw` unguarded; drop the object and the call dies with a
    // TypeError before `edgeCacheIt` is reached. `false` is the realistic value for the
    // anonymous public caller these tests model.
    features: { canViewNsfw: false },
  };
}

/**
 * Call the procedure through tRPC's own caller. Returns the root context — the one
 * `responseMeta` is handed — plus whatever the procedure resolved to.
 */
async function callGetHomeBlock(opts: {
  user?: Ctx['user'];
  ttls?: { browserTTL: number; edgeTTL: number; staleWhileRevalidate: number };
}) {
  const root = rootCtx(opts.user, opts.ttls ?? SENTINEL);
  const caller = createCaller(root as unknown as Context);
  const data = await caller.getHomeBlock({ id: 7 });
  return { root, data };
}

const announcement = { id: 7, type: HomeBlockType.Announcement, metadata: {} };
const collection = { id: 7, type: HomeBlockType.Collection, metadata: {} };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('homeBlock.getHomeBlock edge-cache chain', () => {
  describe('Announcement block — the resolver opts out', () => {
    it('zeroes the edge TTL the response header is built from (anonymous)', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await callGetHomeBlock({ ttls: PROD_DEFAULTS.anonymous });

      expect(root.cache.edgeTTL).toBe(0);
      expect(willEdgeCache(root.cache)).toBe(false);
    });

    it('zeroes the edge TTL for an authenticated caller too', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await callGetHomeBlock({
        user: { id: 1 },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(0);
      expect(willEdgeCache(root.cache)).toBe(false);
    });

    // The two assertions above use the production defaults, where "wrote 0" and "the
    // anonymous default was never overwritten" are distinguishable only for the
    // authenticated arm. From a sentinel root, 0 can ONLY have been written.
    it('WRITES the zero rather than leaving the incoming TTL alone', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await callGetHomeBlock({});

      expect(root.cache.edgeTTL).toBe(0);
      expect(root.cache.browserTTL).toBe(0);
    });

    // Discriminates this fix from a `canCache = false`-shaped one: that route skips the
    // whole assignment block, so the sentinel would survive on every field. Here the
    // block runs and only the TTLs are zero.
    it('still runs the cache-assignment block (staleWhileRevalidate is written)', async () => {
      getHomeBlockById.mockResolvedValue(announcement);

      const { root } = await callGetHomeBlock({});

      expect(root.cache.staleWhileRevalidate).toBe(30);
      expect(root.cache.staleWhileRevalidate).not.toBe(SENTINEL.staleWhileRevalidate);
    });
  });

  describe('non-Announcement block — unchanged, still edge-cached', () => {
    // Positive control for every assertion above: without these, "edgeTTL is 0" would
    // also pass with `edgeCacheIt` absent, inert, or never reached.
    it('writes the middleware ttl for an anonymous caller', async () => {
      getHomeBlockById.mockResolvedValue(collection);

      const { root } = await callGetHomeBlock({});

      expect(root.cache.edgeTTL).toBe(60);
      expect(root.cache.browserTTL).toBe(60);
      expect(willEdgeCache(root.cache)).toBe(true);
    });

    it('writes the middleware ttl for an authenticated caller', async () => {
      getHomeBlockById.mockResolvedValue(collection);

      const { root } = await callGetHomeBlock({
        user: { id: 1 },
        ttls: PROD_DEFAULTS.authenticated,
      });

      expect(root.cache.edgeTTL).toBe(60);
      expect(willEdgeCache(root.cache)).toBe(true);
    });
  });

  it('leaves the call succeeding — the opt-out is not an error path', async () => {
    getHomeBlockById.mockResolvedValue(announcement);

    const { data } = await callGetHomeBlock({});

    expect(data).toEqual(announcement);
    expect(getHomeBlockById).toHaveBeenCalledTimes(1);
  });

  // Reachability control. Every assertion above is a claim about middlewares that ran;
  // this shows the real chain is genuinely being executed rather than short-circuited
  // into a shape where `edgeCacheIt` is never reached and 0 means "nothing happened".
  it('is running the real chain — an earlier middleware can still stop it', async () => {
    getHomeBlockById.mockResolvedValue(collection);
    const root = rootCtx(undefined, SENTINEL);
    root.acceptableOrigin = false;

    const caller = createCaller(root as unknown as Context);
    await expect(caller.getHomeBlock({ id: 7 })).rejects.toThrow();

    // The sentinel survives untouched, and the resolver never ran: proof that reaching
    // `edgeCacheIt` at all is a property of this chain and not of the harness.
    expect(root.cache.edgeTTL).toBe(SENTINEL.edgeTTL);
    expect(root.cache.browserTTL).toBe(SENTINEL.browserTTL);
    expect(getHomeBlockById).not.toHaveBeenCalled();
  });

  // The fixture is the enum member, not the string literal the controller happens to
  // compare against today, so the fixture cannot drift away from the value under test.
  it('pins the fixture to the enum the controller branches on', () => {
    expect(HomeBlockType.Announcement).toBe('Announcement');
    expect(announcement.type).toBe(HomeBlockType.Announcement);
    expect(collection.type).not.toBe(HomeBlockType.Announcement);
  });
});

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
// via `model.service` -> `paid-access.service` -> `server/common/constants`. That resolved
// fine locally and threw in CI ("Invalid environment variables", failing the whole file as a
// suite-level error rather than an assertion), so pin it here rather than depend on ambient
// env. Same shape as `middleware.trpc.rate-limit-key.test.ts`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

// tRPC's `_def.middlewares` ends with the wrapper that invokes the resolver, so
// running the real chain runs the real handler. Stub the one service it calls so the
// chain completes without a database — the subject here is the middleware ordering
// and context propagation, not the query. Same pattern as
// `model.paged-simple-cacheability.test.ts`.
import type * as ModelService from '~/server/services/model.service';

const { getModelsWithImagesAndModelVersions } = vi.hoisted(() => ({
  getModelsWithImagesAndModelVersions: vi.fn(),
}));

vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getModelsWithImagesAndModelVersions,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { modelRouter } from '~/server/routers/model.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * `model.getAll`'s middleware chain, run in order, asserting the thing that
 * actually reaches the wire.
 *
 * The isolation test alongside this one exercises `skipEdgeCache` on its own,
 * which cannot see two structural properties this one pins:
 *
 * 1. **`responseMeta` reads the ROOT context, not the merged one.** tRPC's
 *    `next({ ctx })` builds a new object (`{ ...opts.ctx, ...nextOpts.ctx }`) and
 *    hands `responseMeta` the root (`ctxManager.valueOrUndefined()`). Because
 *    `skipEdgeCache` passes `cache: { ...ctx.cache, skip }` — a COPY —
 *    `edgeCacheIt`'s `ctx.cache.edgeTTL = reqTTL` lands on the copy and never
 *    reaches the header. The root keeps `createContext`'s values, which are
 *    already 0 for a session. `model.getAll` is the only production router that
 *    replaces `ctx.cache`, so it is the only one with this property.
 * 2. **Order is load-bearing.** `edgeCacheIt` reads `ctx.cache.skip` to compute
 *    the TTL BEFORE calling the resolver, so `skipEdgeCache` only works upstream
 *    of it. Swapping the two `.use()` calls makes the guard inert — and leaves
 *    the isolation test green, because it never runs the chain.
 *
 * A sentinel root TTL (999) is what makes both observable: the real anonymous
 * default and `edgeCacheIt`'s own ttl are both 60, so with realistic values a
 * write and a no-write are indistinguishable.
 */
type Ctx = {
  user?: { id: number; isModerator?: boolean };
  // `isAcceptableOrigin` (src/server/trpc.ts:124) runs ahead of these middlewares on
  // every publicProcedure and throws UNAUTHORIZED without it, so the chain never
  // reaches the cache middlewares at all. It is also why an error response can never
  // carry a cache header: `responseMeta` only sets one when `errors.length === 0`.
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

const PATH = 'model.getAll';
const SENTINEL = 999;

const middlewares = (
  modelRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures.getAll._def.middlewares;

function rootCtx(user?: Ctx['user']): Ctx {
  return {
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    // Deliberately NOT the production defaults — see the docstring.
    cache: {
      browserTTL: SENTINEL,
      edgeTTL: SENTINEL,
      staleWhileRevalidate: SENTINEL,
      canCache: true,
      skip: false,
    },
    features: {},
  };
}

/**
 * Run the whole chain, replicating tRPC's context merge exactly:
 *   ctx = nextOpts?.ctx ? { ...opts.ctx, ...nextOpts.ctx } : opts.ctx
 * Returns the root (what `responseMeta` sees) and the context the resolver ran with.
 */
async function runChain(user?: Ctx['user'], input: unknown = { limit: 10 }) {
  const root = rootCtx(user);
  const seen: Ctx[] = [];
  let i = 0;

  const step = async (ctx: Ctx): Promise<unknown> => {
    seen.push(ctx);
    if (i >= middlewares.length) {
      return { ok: true, data: {}, marker: undefined, ctx };
    }
    const mw = middlewares[i++];
    return mw({
      input,
      ctx,
      path: PATH,
      getRawInput: async () => input,
      type: 'query',
      next: (opts?: { ctx?: Partial<Ctx> }) =>
        step(opts?.ctx ? ({ ...ctx, ...opts.ctx } as Ctx) : ctx),
    });
  };

  await step(root);
  // The context `skipEdgeCache` handed downstream is the one carrying a COPIED
  // cache object — identified by reference, not by position, so this keeps working
  // if the chain gains a middleware. It is the object `edgeCacheIt` writes to.
  const downstream = seen.find((c) => c.cache !== root.cache);
  return { root, downstream };
}

beforeEach(() => {
  vi.clearAllMocks();
  getModelsWithImagesAndModelVersions.mockResolvedValue({
    items: [],
    nextCursor: undefined,
    isPrivate: false,
  });
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockResolvedValue(undefined);
  redisMock.redis.eval.mockResolvedValue(1);
});

describe('model.getAll edge-cache chain', () => {
  it('leaves an authenticated caller un-cacheable in the context responseMeta reads', async () => {
    const { root } = await runChain({ id: 1 });
    expect(root.cache.edgeTTL).toBe(SENTINEL);
  });

  it('leaves a moderator un-cacheable in the context responseMeta reads', async () => {
    const { root } = await runChain({ id: 1, isModerator: true });
    expect(root.cache.edgeTTL).toBe(SENTINEL);
  });

  it('does not let edgeCacheIt reach the root context for an anonymous caller either', async () => {
    const { root } = await runChain(undefined);
    expect(root.cache.edgeTTL).toBe(SENTINEL);
  });

  // Positive control for the two assertions above: without this, "the root was not
  // written" would also pass if `edgeCacheIt` were absent or inert, and the tests
  // would be measuring nothing.
  it('still has a live edgeCacheIt writing the TTL downstream (anonymous)', async () => {
    const { downstream } = await runChain(undefined);
    expect(downstream?.cache.edgeTTL).toBe(60);
  });

  it('has the guard zero the downstream TTL for an authenticated caller', async () => {
    const { downstream } = await runChain({ id: 1 });
    expect(downstream?.cache.edgeTTL).toBe(0);
  });
});

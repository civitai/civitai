import { describe, expect, it, vi } from 'vitest';

// `edgeCacheIt` returns early when `!isProd`, so the TTL-assigning block only runs with
// this mocked true. Same shape as `middleware.trpc.test.ts`.
vi.mock('~/env/other', () => ({
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));

vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

import type { Context } from '~/server/createContext';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { createCallerFactory, publicProcedure, router } from '~/server/trpc';
import { willEdgeCache } from '~/server/trpc/edge-cache-headers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * PRECEDENCE between `edgeCacheIt`'s two TTL-overriding inputs: a resolver-set
 * `ctx.cache.skip` versus a configured `expireAt`.
 *
 * `edgeCacheIt` computes the request TTL in three steps:
 *
 *     let reqTTL = ctx.cache.skip ? 0 : ttl;                      // incoming skip
 *     if (expireAt) reqTTL = Math.floor(...);                     // scheduled expiry
 *     const result = await next();
 *     if (ctx.cache?.skip) reqTTL = 0;                            // resolver-set skip
 *
 * Before the third line existed, `expireAt` silently overrode a pre-set `skip`. It now
 * loses to it. That is the intended ordering, not an accident of where the line landed:
 * `expireAt` says "this content goes stale at time T", which is a statement about content
 * that IS cacheable; `skip` says "this particular response must not be cached at all".
 * The stronger claim wins — a response the resolver declared uncacheable does not become
 * cacheable because someone also scheduled when it should expire.
 *
 * ── WHY A SYNTHETIC PROCEDURE ───────────────────────────────────────────────────────────
 * `expireAt` has ZERO production call sites today (`git grep` finds only its type
 * declaration and its single use inside `edgeCacheIt`), so there is no real procedure that
 * combines it with a resolver-set `skip` and therefore no cross-file relationship to pin.
 * The dimension is real regardless — the option is exported and reachable — so it is
 * exercised here on a purpose-built router rather than by bending an existing one. Note
 * this is a synthetic PROCEDURE driven by the real `createCallerFactory` runner, not a
 * hand-invoked middleware: the ordering under test is an ordering of real chain steps, so
 * the chain is real and only the procedure is synthetic.
 *
 * Without this file the mutant `if (ctx.cache?.skip && !expireAt) reqTTL = 0;` — i.e. a
 * restoration of the old precedence — survives the whole suite.
 */

/** Comfortably distinguishable from the `ttl` below and from any context default. */
const EXPIRE_IN_SECONDS = 900;
const expireAt = () => new Date(Date.now() + EXPIRE_IN_SECONDS * 1000);

/** Not 0, not 900, not a context default. */
const TTL = 60;

const SENTINEL = { browserTTL: 111, edgeTTL: 222, staleWhileRevalidate: 333 };

const testRouter = router({
  // Resolver only learns its response is uncacheable once it has produced one — the
  // shape `home-block.getHomeBlock` has in production, plus an `expireAt`.
  optsOutAfterResolving: publicProcedure
    .use(edgeCacheIt({ ttl: TTL, expireAt }))
    .query(({ ctx }) => {
      if (ctx.cache) ctx.cache.skip = true;
      return { resolved: true };
    }),
  // Control: identical procedure, identical `expireAt`, resolver does NOT opt out.
  keepsTheScheduledExpiry: publicProcedure
    .use(edgeCacheIt({ ttl: TTL, expireAt }))
    .query(() => ({ resolved: true })),
});

const createCaller = createCallerFactory(testRouter);

function rootCtx() {
  return {
    user: undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { ...SENTINEL, canCache: true, skip: false },
    // Present for context realism only — MEASURED INERT for this file: delete this key
    // and all 3 tests here still pass. `applyDomainFeature` (src/server/trpc.ts) does
    // read `ctx.features.canViewNsfw`, but only on the authenticated arm: with `ctx.req`
    // undefined, `parseVerifiedBotHeader(undefined)` returns null and the `&&`
    // short-circuits before the property is reached, and the anonymous branch of
    // `maxAllowed` never reads it either. Every case in this file is anonymous.
    //
    // Said plainly because the previous version of this comment claimed omitting the key
    // "dies with a TypeError before the middleware under test runs" — that is false here,
    // and it is the same defect (a test-context key documented as load-bearing that the
    // code path never touches) that this PR exists to fix.
    features: { canViewNsfw: false },
  };
}

describe('edgeCacheIt — skip vs expireAt precedence', () => {
  it('CONTROL: expireAt drives the TTL when the resolver does not opt out', async () => {
    const root = rootCtx();

    await createCaller(root as unknown as Context).keepsTheScheduledExpiry();

    // Proof `expireAt` is genuinely in play on these procedures — without this the
    // opt-out assertion below could pass on a chain where `expireAt` never ran, and the
    // `&& !expireAt` mutant would have nothing to disagree with.
    expect(root.cache.edgeTTL).toBeGreaterThan(TTL);
    expect(root.cache.edgeTTL).toBeLessThanOrEqual(EXPIRE_IN_SECONDS);
    expect(root.cache.edgeTTL).toBeGreaterThanOrEqual(EXPIRE_IN_SECONDS - 5);
    expect(root.cache.edgeTTL).not.toBe(SENTINEL.edgeTTL);
    expect(willEdgeCache(root.cache)).toBe(true);
  });

  it('a resolver-set skip BEATS expireAt — the TTL is zeroed, not the scheduled expiry', async () => {
    const root = rootCtx();

    await createCaller(root as unknown as Context).optsOutAfterResolving();

    expect(root.cache.edgeTTL).toBe(0);
    expect(root.cache.browserTTL).toBe(0);
    expect(willEdgeCache(root.cache)).toBe(false);
  });

  it('an INCOMING skip also beats expireAt', async () => {
    const root = rootCtx();
    root.cache.skip = true;

    await createCaller(root as unknown as Context).keepsTheScheduledExpiry();

    // The pre-`next()` read is overwritten by the `expireAt` line immediately below it,
    // so this outcome comes entirely from the post-resolver re-read. A caller that set
    // `skip` upstream (`model.getAll`) therefore gets the same answer either way.
    expect(root.cache.edgeTTL).toBe(0);
    expect(willEdgeCache(root.cache)).toBe(false);
  });
});

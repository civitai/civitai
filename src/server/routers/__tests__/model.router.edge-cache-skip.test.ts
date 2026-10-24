import { beforeAll, describe, expect, it } from 'vitest';

import { modelRouter } from '~/server/routers/model.router';

/**
 * `model.getAll` is edge-cached (`edgeCacheIt({ ttl: 60 })`), and its response is
 * caller-dependent: `getModelsWithImagesAndModelVersions` branches on
 * `user.isModerator` for status filtering and on `model.user.id === user?.id` for
 * owner-only fields, and the controller reads two per-user feature flags
 * (`getAllModelImagesSlim`, `modelMetricPrivacyReadtime`). None of that is in the
 * edge cache key, so a response computed for one caller can be served to another.
 *
 * The opt-out has to run in a middleware UPSTREAM of `edgeCacheIt`: `edgeCacheIt`
 * reads `ctx.cache.skip` to compute the TTL *before* it calls the resolver, so a
 * resolver assigning `ctx.cache.skip` is inert (see the comment in
 * `system.router.ts`, and `home-block.controller.ts` for a live instance of that
 * mistake).
 *
 * These tests pin the middleware's decision directly rather than the header it
 * eventually produces, because that is where the caller-dependence is known.
 */
type Middleware = (opts: {
  input?: unknown;
  ctx: unknown;
  next: (opts?: { ctx?: unknown }) => unknown;
  path: string;
}) => Promise<unknown>;

const PATH = 'model.getAll';

const middlewares = (
  modelRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures.getAll._def.middlewares;

type User = { id: number; isModerator?: boolean };

/** Run one middleware and report the `cache.skip` it handed downstream. */
async function skipFor(mw: Middleware, input: unknown, user?: User) {
  let seen: { skip?: boolean } | undefined;
  await mw({
    input,
    ctx: { cache: { canCache: true }, user, features: {} },
    next: (opts?: { ctx?: unknown }) => {
      const ctx = opts?.ctx as { cache?: { skip?: boolean } } | undefined;
      if (ctx?.cache && 'skip' in ctx.cache) seen = ctx.cache;
      return { ok: true, data: {} };
    },
    path: PATH,
  });
  return seen?.skip;
}

let mw: Middleware;

beforeAll(async () => {
  // Identify the opt-out middleware by BEHAVIOUR, not by position in the chain —
  // a reordered `.use()` must not silently retarget these assertions. Require
  // exactly one match so that adding a second skip-setting middleware fails here
  // rather than quietly testing whichever came first.
  const matches: Middleware[] = [];
  for (const candidate of middlewares) {
    const skip = await skipFor(candidate, { limit: 10, favorites: true }).catch(() => undefined);
    if (skip !== undefined) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw new Error(
      `${PATH}: expected exactly 1 middleware setting ctx.cache.skip, found ${matches.length}`
    );
  }
  mw = matches[0];
});

describe('model.getAll edge-cache opt-out', () => {
  // Falsy rather than `false`: the assertion is "this stays cacheable", and it must
  // not break if the expression's falsy value changes shape. Anonymous traffic is
  // the bulk of the edge-cache hits on this procedure — an opt-out that swallowed
  // it would trade a leak for an origin-load regression.
  it('caches for an anonymous caller (the response is the same for all of them)', async () => {
    await expect(skipFor(mw, { limit: 10 })).resolves.toBeFalsy();
  });

  it('skips for a caller-specific input: favorites', async () => {
    await expect(skipFor(mw, { limit: 10, favorites: true })).resolves.toBe(true);
  });

  it('skips for a caller-specific input: hidden', async () => {
    await expect(skipFor(mw, { limit: 10, hidden: true })).resolves.toBe(true);
  });

  it('skips for an authenticated caller, whose response can carry owner-only fields', async () => {
    await expect(skipFor(mw, { limit: 10 }, { id: 1 })).resolves.toBe(true);
  });

  it('skips for a moderator, whose response can carry moderator-only statuses', async () => {
    await expect(skipFor(mw, { limit: 10 }, { id: 1, isModerator: true })).resolves.toBe(true);
  });
});

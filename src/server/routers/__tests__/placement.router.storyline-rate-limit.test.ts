import { describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import { STORYLINE_SUBMIT_RATE_LIMIT } from '~/shared/utils/storyline-placement';

/**
 * 🔴 The submit rate limit is the only spam control a zero-priced storyline
 * has: a continuation there costs the placer nothing, and the pending cap
 * bounds one placer per creator. `rateLimit` skips itself under test, so its
 * behaviour cannot be exercised here. What is pinned is that the procedure is
 * built with it, at these numbers: delete the `.use(rateLimit(...))` and this
 * goes red.
 */
const { rateLimitCalls, built } = vi.hoisted(() => ({
  rateLimitCalls: [] as unknown[][],
  built: new Set<unknown>(),
}));

vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const original = await importOriginal<typeof MiddlewareTrpc>();
  return {
    ...original,
    rateLimit: (...args: Parameters<typeof original.rateLimit>) => {
      rateLimitCalls.push(args);
      const middleware = original.rateLimit(...args);
      // A middleware builder is applied as the functions it holds.
      built.add(middleware);
      for (const fn of (middleware as unknown as { _middlewares?: unknown[] })._middlewares ?? [])
        built.add(fn);
      return middleware;
    },
  };
});

const { placementRouter } = await import('~/server/routers/placement.router');

type ProcedureDef = { _def: { middlewares: unknown[] } };
const procedure = (name: string) =>
  (placementRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def
    .procedures[name];

describe('submitStorylineContinuation is rate-limited', () => {
  it('is built with the storyline submit limit', () => {
    expect(STORYLINE_SUBMIT_RATE_LIMIT).toMatchObject({ limit: 30, period: 3600 });
    // On the quota `post.update` shares for the continuations a publish submits.
    expect(rateLimitCalls).toContainEqual([
      expect.objectContaining({ limit: 30, period: 3600 }),
      undefined,
      { sharedKey: 'storyline:submitContinuation' },
    ]);
  });

  it('carries that limiter in its own middleware chain', () => {
    const chain = procedure('submitStorylineContinuation')._def.middlewares;
    expect(chain.filter((middleware) => built.has(middleware))).toHaveLength(1);
  });

  // The control: a procedure built without one carries none of them.
  it('is the only storyline procedure that carries one', () => {
    for (const name of ['retractStorylineContinuation', 'actOnStorylineContinuation'])
      expect(procedure(name)._def.middlewares.filter((m) => built.has(m))).toHaveLength(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type * as MiddlewareTrpc from '~/server/middleware.trpc';
import { STORYLINE_SUBMIT_RATE_LIMIT } from '~/shared/utils/storyline-placement';

/**
 * Publishing a drafted continuation submits it, so `post.update` carries the submit procedure's
 * spam bound, on the same quota, for exactly the publishes that can submit one. `rateLimit` skips
 * itself under test (see placement.router.storyline-rate-limit.test.ts), so what is pinned is how
 * the procedure is built.
 */
const { rateLimitCalls, built } = vi.hoisted(() => ({
  rateLimitCalls: [] as unknown[][],
  built: new Map<unknown, unknown[]>(),
}));

vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const original = await importOriginal<typeof MiddlewareTrpc>();
  return {
    ...original,
    rateLimit: (...args: Parameters<typeof original.rateLimit>) => {
      rateLimitCalls.push(args);
      const middleware = original.rateLimit(...args);
      built.set(middleware, args);
      for (const fn of (middleware as unknown as { _middlewares?: unknown[] })._middlewares ?? [])
        built.set(fn, args);
      return middleware;
    },
  };
});

const { postRouter } = await import('~/server/routers/post.router');

type ProcedureDef = { _def: { middlewares: unknown[] } };
const limitersOf = (name: string) =>
  (postRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def.procedures[
    name
  ]._def.middlewares
    .map((middleware) => built.get(middleware))
    .filter(Boolean) as Parameters<typeof MiddlewareTrpc.rateLimit>[];

describe('post.update counts a continuation it submits against the submit quota', () => {
  it('carries the storyline submit limit, on the shared key', () => {
    const storyline = limitersOf('update').filter(
      ([, , options]) => options?.sharedKey === STORYLINE_SUBMIT_RATE_LIMIT.rateLimitKey
    );
    expect(storyline).toHaveLength(1);
    expect(storyline[0][0]).toMatchObject({ limit: 30, period: 3600 });
  });

  it('counts only a publish that names a price, which every submitting publish does', () => {
    const [[, condition]] = limitersOf('update').filter(
      ([, , options]) => options?.sharedKey === STORYLINE_SUBMIT_RATE_LIMIT.rateLimitKey
    );
    expect(condition?.({ id: 1, publishedAt: new Date(), expectedPrice: 0 })).toBe(true);
    expect(condition?.({ id: 1, publishedAt: new Date() })).toBe(false);
    expect(condition?.({ id: 1, title: 'edit' })).toBe(false);
  });
});

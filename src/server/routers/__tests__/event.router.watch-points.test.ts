import { describe, expect, it, vi } from 'vitest';
import type * as MiddlewareModule from '~/server/middleware.trpc';

/**
 * The watch endpoint's rate limit. The limiter itself is tested with the middleware, and it is
 * skipped in tests (isTest), so this pins the configuration the router hands it, and that it is on
 * watchPoints: a page marks a few sections every 30s, about 6 calls a minute; 60 is the ceiling.
 */

const { rateLimit } = vi.hoisted(() => ({ rateLimit: vi.fn() }));
vi.mock('~/server/middleware.trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof MiddlewareModule>();
  rateLimit.mockImplementation((...args: Parameters<typeof actual.rateLimit>) =>
    actual.rateLimit(...args)
  );
  return { ...actual, rateLimit };
});

describe('event.watchPoints', () => {
  it('is rate limited to 60 calls a minute per caller, on this procedure', async () => {
    const { eventRouter } = await import('~/server/routers/event.router');
    const at = rateLimit.mock.calls.findIndex(
      ([opts]) => JSON.stringify(opts) === '{"limit":60,"period":60}'
    );
    expect(at).toBeGreaterThanOrEqual(0);
    // A tRPC middleware builder: its functions are what a procedure runs.
    const [limiter] = (rateLimit.mock.results[at].value as { _middlewares: unknown[] })
      ._middlewares;
    const middlewares = (name: string) =>
      (eventRouter._def.procedures as Record<string, { _def: { middlewares: unknown[] } }>)[name]
        ._def.middlewares;
    expect(middlewares('watchPoints')).toContain(limiter);
    // The control: the same limiter is not on a neighbouring procedure.
    expect(middlewares('getUserRank')).not.toContain(limiter);
  });
});

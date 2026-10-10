import { describe, expect, it, vi } from 'vitest';
import type * as MiddlewareModule from '~/server/middleware.trpc';

/**
 * The watch endpoint's rate limit. The limiter itself is tested with the middleware, and it is
 * skipped in tests (isTest), so this pins the configuration the router hands it: one caller marks a
 * few sections every 30s, about 2 calls a minute; 20 a minute is the ceiling.
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
  it('is rate limited to 20 calls a minute per caller', async () => {
    const { eventRouter } = await import('~/server/routers/event.router');
    expect(eventRouter._def.procedures.watchPoints).toBeDefined();
    expect(rateLimit.mock.calls).toEqual([[{ limit: 20, period: 60 }]]);
  });
});

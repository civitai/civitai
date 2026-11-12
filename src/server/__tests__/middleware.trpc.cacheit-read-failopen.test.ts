import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `cacheIt`'s cache READ must never decide the request. A cluster read that rejects, or one that
 * was sent and never answered, is a cache miss: the procedure runs and its result is returned,
 * within the cache-read deadline rather than the client's 15s backstop.
 *
 * Same harness as middleware.trpc.cacheit.test.ts: `middleware(fn)` is the identity, so the raw
 * middleware runs against the canonical redis mock.
 */

vi.mock('~/server/trpc', () => ({ middleware: (fn: unknown) => fn }));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { cacheIt } from '~/server/middleware.trpc';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const redisFake = redisMock.redis;
const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

const COMPUTED = { ok: true, data: { foo: 'bar' }, marker: undefined, ctx: {} };

function invoke(next: ReturnType<typeof vi.fn>) {
  const ctx = { cache: { canCache: true }, user: undefined };
  const mw = cacheIt<{ id: number }>({ ttl: 100 }) as unknown as (opts: {
    input: { id: number };
    ctx: typeof ctx;
    next: typeof next;
    path: string;
  }) => Promise<unknown>;
  return mw({ input: { id: 1 }, ctx, next, path: 'test.proc' });
}

beforeEach(() => {
  vi.clearAllMocks();
  redisFake.packed.set.mockResolvedValue(undefined);
});

describe('cacheIt cache-read fail-open', () => {
  it('a rejecting cache read runs the procedure and returns its result', async () => {
    redisFake.packed.get.mockRejectedValue(new Error('cluster down'));
    const next = vi.fn().mockResolvedValue(COMPUTED);

    const result = await within(invoke(next), 1000);

    expect(result).toBe(COMPUTED);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a cache read that never answers releases the request within 750ms', async () => {
    redisFake.packed.get.mockImplementation(() => new Promise(() => {}));
    const next = vi.fn().mockResolvedValue(COMPUTED);

    const started = Date.now();
    const result = await within(invoke(next), 2000);
    const elapsed = Date.now() - started;

    expect(result).toBe(COMPUTED);
    expect(elapsed).toBeLessThan(750);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

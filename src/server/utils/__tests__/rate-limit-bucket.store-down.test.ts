import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rate limiter when its store (the cluster cache) is unavailable.
 *
 * A read that rejects, or one that was sent and never answered, must neither fail the request nor
 * switch the limit off: the limiter counts attempts in this process instead, so a caller is still
 * refused past the limit — per pod, until the store answers again — and the request is decided
 * within the cache-read deadline, not the client's 15s backstop.
 *
 * `~/env/other` is mocked production-like: the limiter exempts dev/test/preview, so without it the
 * body under test never runs.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));

import { hSetWithTTL } from '~/server/redis/atomic';
import { claimRateLimitAttempt } from '~/server/utils/rate-limit-bucket';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const hGet = redisMock.redis.packed.hGet;
const HUNG = Symbol('hung');
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

let ipCounter = 0;
/** A distinct client address per test, so one test's local attempts never reach another's bucket. */
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `203.0.113.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];

async function attempt(req: NextApiRequest, keyName = 'store-down:test') {
  const record = await claimRateLimitAttempt({ rules: RULES, keyName, user: undefined, req });
  await record();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hSetWithTTL).mockResolvedValue(undefined as never);
});

describe('claimRateLimitAttempt with the store unavailable', () => {
  it('a rejecting store admits callers up to the limit, then refuses with TOO_MANY_REQUESTS', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const req = freshReq();

    for (let i = 0; i < 3; i++) await expect(attempt(req)).resolves.toBeUndefined();

    const refused = await attempt(req).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('a store that never answers decides each attempt within 750ms and still refuses past the limit', async () => {
    hGet.mockImplementation(() => new Promise(() => undefined));
    const req = freshReq();

    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      const outcome = await within(attempt(req), 2000);
      expect(outcome).not.toBe(HUNG);
      expect(Date.now() - started).toBeLessThan(750);
    }

    const refused = await within(
      attempt(req).catch((e: unknown) => e),
      2000
    );
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('counts each caller separately: another address is still admitted', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const a = freshReq();
    const b = freshReq();

    for (let i = 0; i < 3; i++) await attempt(a);
    await expect(attempt(a)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    await expect(attempt(b)).resolves.toBeUndefined();
  });
});

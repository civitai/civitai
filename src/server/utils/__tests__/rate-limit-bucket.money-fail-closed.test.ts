import { TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * (The ledger classifying every rate-limiting router is a convention guard:
 * src/server/services/__tests__/no-unclassified-rate-limit-router.test.ts.)
 *
 * Money and generation procedures stay FAIL-CLOSED when the rate limiter's store is unavailable.
 *
 * The per-process fallback count (rate-limit-bucket.store-down.test.ts) keeps ordinary procedures
 * working through a cache outage. For buzz, payment and generation/orchestrator procedures the
 * operator's call is the opposite: refuse with a clear 503 (SERVICE_UNAVAILABLE — never a 500)
 * rather than admit on a count the store cannot confirm. The decision is made from the PROCEDURE'S
 * router (its tRPC path), never from a sharedKey, so a money procedure cannot escape it by sharing a
 * bucket with a non-money key.
 */

vi.mock('~/env/other', () => ({ isDev: false, isProd: true, isTest: false, isPreview: false }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: vi.fn() }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/trpc', () => ({ middleware: (fn: unknown) => fn }));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn().mockResolvedValue({}),
}));

import { hSetWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { rateLimit } from '~/server/middleware.trpc';
import * as bucket from '~/server/utils/rate-limit-bucket';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const { claimRateLimitAttempt } = bucket;
const hGet = redisMock.redis.packed.hGet;

let ipCounter = 0;
const freshReq = () =>
  ({
    headers: { 'cf-connecting-ip': `198.51.100.${++ipCounter}` },
    socket: { remoteAddress: '10.0.0.1' },
  } as unknown as NextApiRequest);

const RULES = [{ limit: 3, period: 60 }];

async function claim(keyName: string, scope?: string) {
  const record = await claimRateLimitAttempt({
    rules: RULES,
    keyName,
    scope,
    user: undefined,
    req: freshReq(),
  } as Parameters<typeof claimRateLimitAttempt>[0]);
  await record();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetEnv();
  vi.mocked(hSetWithTTL).mockResolvedValue(undefined as never);
});

const MONEY_SCOPES = ['buzz', 'nowPayments', 'generation', 'orchestrator', 'remixApp', 'training'];

describe('claimRateLimitAttempt, money scopes, store unavailable', () => {
  it.each(MONEY_SCOPES)('%s: a rejecting store refuses the first attempt with a 503', async (s) => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const err = await claim(`${s}:someProcedure`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('a store that never answers refuses with a 503 at the longer fail-closed deadline (2000ms), not before', async () => {
    // Fake timers: the guard's deadline is a plain setTimeout race, so the bound is exact here
    // rather than a wall-clock window that a loaded CI machine can stretch.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    hGet.mockImplementation(() => new Promise(() => undefined));
    const PENDING = Symbol('pending');
    let outcome: unknown = PENDING;
    const done = claim('buzz:getUserAccount').then(
      () => (outcome = 'admitted'),
      (e: unknown) => (outcome = e)
    );

    await vi.advanceTimersByTimeAsync(1999);
    expect(outcome).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    // Settled by now or never: a real macrotask turn, not a wait on a promise that may not settle.
    await Promise.race([done, new Promise((r) => setImmediate(r))]);
    expect(outcome).toBeInstanceOf(TRPCError);
    expect((outcome as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
  });

  it('a slow read (500ms) on a money scope is answered, not refused', async () => {
    hGet.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 500)));
    await expect(claim('buzz:getUserAccount')).resolves.toBeUndefined();
  });

  it('control: the same 500ms read on a non-money scope still degrades under the default deadline', async () => {
    hGet.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 500)));
    await claim('post:create', 'post.create');
    expect(logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'rate-limit-bucket.read',
      expect.anything(),
      expect.objectContaining({ reason: 'timeout' })
    );
  });

  it('REDIS_CACHE_READ_DEADLINE_MS=0 switches the fail-closed bound off too', async () => {
    setEnv({ REDIS_CACHE_READ_DEADLINE_MS: 0 });
    // Slower than the fail-closed bound: answered only because no deadline applies at all.
    hGet.mockImplementation(() => new Promise((r) => setTimeout(() => r([]), 2300)));
    await expect(claim('buzz:getUserAccount')).resolves.toBeUndefined();
  });
});

describe('rateLimit middleware passes the procedure path as the scope', () => {
  it('a buzz procedure on a shared non-money key fails closed with a 503', async () => {
    hGet.mockRejectedValue(new Error('cluster down'));
    const mw = rateLimit(RULES, undefined, { sharedKey: 'post:shared-bucket' }) as unknown as (
      opts: unknown
    ) => Promise<unknown>;
    const next = vi.fn().mockResolvedValue({ ok: true });
    const err = await mw({
      ctx: { user: undefined, req: freshReq() },
      input: {},
      next,
      path: 'buzz.claimDailyBoostReward',
    }).catch((e: unknown) => e);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('money-scope list sign-off', () => {
  // A deliberate SIGN-OFF PIN: literal equality, so adding OR removing a fail-closed router is a
  // reviewed change to this list, never a side effect of editing FAIL_CLOSED_RATE_LIMIT_SCOPES alone.
  it('keeps buzz, payments and generation fail-closed', () => {
    expect([...bucket.FAIL_CLOSED_RATE_LIMIT_SCOPES].sort()).toEqual([...MONEY_SCOPES].sort());
  });
});

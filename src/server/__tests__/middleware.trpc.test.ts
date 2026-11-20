import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Tests for the rate-limit `recordAttempt` closure inside
 * `middleware.trpc.rateLimit()`. The two properties under test:
 *
 *   1. `onlyCountSuccess: true` defers the recordAttempt write until AFTER
 *      `next()` resolves — and skips the write entirely when the inner
 *      procedure throws (so failed calls don't burn a slot). This is the
 *      branch the comment "// When onlyCountSuccess is set, defer
 *      recording until the procedure succeeds" claims.
 *
 *   2. PR #2332 round-4 fail-open wrapper: an EVAL throw from `hSetWithTTL`
 *      (e.g. during a cache-redis cluster failover) must NOT 500 the
 *      request — `logSysRedisFailOpen('rate-limit-write-degraded', ...)`
 *      fires and the original `next()` result still propagates.
 *
 * We don't need to boot the full tRPC framework to exercise these — we
 * intercept `~/server/trpc`'s `middleware()` and capture the handler the
 * factory passes in, then invoke it directly with a synthetic
 * { ctx, input, next, path } shape. This mirrors what tRPC itself does
 * at request time without the full pipeline.
 */

const { mockHSetWithTTL, mockLogSysRedisFailOpen, capturedHandler } = vi.hoisted(() => {
  const captured: { handler: ((arg: unknown) => Promise<unknown>) | null } = { handler: null };
  return {
    mockHSetWithTTL: vi.fn(),
    mockLogSysRedisFailOpen: vi.fn(),
    capturedHandler: captured,
  };
});

vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: mockHSetWithTTL,
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));

// Capture the inner handler the rateLimit factory passes to `middleware(...)`.
// At the call site, the most recent capture is the rateLimit middleware (the
// applyUserPreferences middleware is captured at module-load and we only
// care about the final one we explicitly construct).
vi.mock('~/server/trpc', () => ({
  middleware: (fn: (arg: unknown) => Promise<unknown>) => {
    capturedHandler.handler = fn;
    return fn;
  },
}));

// Lightweight pass-throughs for everything else in middleware.trpc's import
// graph. These modules are only touched by sibling middlewares we don't
// invoke (applyUserPreferences / cacheIt / edgeCacheIt) — pulling the real
// implementations in would require booting Prisma + redis + Cloudflare
// clients, none of which is relevant to recordAttempt.
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: vi.fn(async () => ({
    hiddenImages: [],
    hiddenTags: [],
    hiddenModels: [],
    hiddenUsers: [],
  })),
}));

vi.mock('~/server/cloudflare/client', () => ({
  purgeCache: vi.fn(async () => undefined),
}));

vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: vi.fn(() => 'blue'),
}));

vi.mock('~/server/utils/otel-helpers', () => ({
  // Identity wrapper — execute the inner function synchronously / async-await
  // as if no span existed. Faithful to the real withSpan's "transparent"
  // semantic for the test.
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

vi.mock('~/env/other', () => ({
  isDev: false,
  isProd: true,
  isTest: false,
  isPreview: false,
}));

// ~/env/client validates NEXT_PUBLIC_* at module load and throws — short-circuit
// here so the import chain through ~/server/common/constants doesn't blow up.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
}));

import { rateLimit } from '../middleware.trpc';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
const mockHGet = redisMock.redis.packed.hGet;
const mockEval = redisMock.redis.eval;
/** The atomic claim script's calls, by op ('claim' | 'refund'). */
const scriptOps = () =>
  mockEval.mock.calls.map((call) => (call[1] as { arguments: string[] }).arguments[0]);

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler.handler = null;
  // No existing attempts — the limit check should pass on every call.
  mockHGet.mockResolvedValue([]);
  mockHSetWithTTL.mockResolvedValue(undefined);
  // The claim script admits; a refund finds its attempt.
  mockEval.mockImplementation(
    async (_script: string, { arguments: args }: { arguments: string[] }) =>
      args[0] === 'claim' ? [1] : 1
  );
});

const baseCtx = {
  user: { id: 42, isModerator: false } as any,
  ip: '127.0.0.1',
};

const baseArg = {
  ctx: baseCtx,
  input: undefined,
  path: 'test:procedure',
};

describe('rateLimit recordAttempt — onlyCountSuccess', () => {
  it('keeps the claimed attempt when onlyCountSuccess=true and next() succeeds', async () => {
    // Construct the middleware — this captures the handler.
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;
    expect(handler).not.toBeNull();

    const next = vi.fn(async () => ({ ok: true, data: 'success', marker: 'next-ran' }));

    const result = (await handler({ ...baseArg, next })) as any;

    expect(next).toHaveBeenCalledTimes(1);
    expect(scriptOps()).toEqual(['claim']);
    expect(mockHSetWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
    // The original next() result must propagate unchanged.
    expect(result.marker).toBe('next-ran');
  });

  it('refunds the claimed attempt once when onlyCountSuccess=true and next() returns ok=false', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;

    const next = vi.fn(async () => ({ ok: false, error: new Error('inner-fail') }));

    const result = (await handler({ ...baseArg, next })) as any;

    expect(next).toHaveBeenCalledTimes(1);
    // A failed call MUST NOT burn a slot: the claim is released, once.
    expect(scriptOps()).toEqual(['claim', 'refund']);
    const [claim, refund] = mockEval.mock.calls.map(
      (call) => (call[1] as { arguments: string[] }).arguments
    );
    expect(refund[2]).toBe(claim[2]);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('refunds when next() throws under onlyCountSuccess, and the error still propagates', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;
    const boom = new Error('procedure threw');

    await expect(
      handler({ ...baseArg, next: vi.fn(async () => Promise.reject(boom)) })
    ).rejects.toBe(boom);
    expect(scriptOps()).toEqual(['claim', 'refund']);
  });

  it('a failing refund does not fail the request', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;
    mockEval.mockImplementation(
      async (_s: string, { arguments: args }: { arguments: string[] }) => {
        if (args[0] === 'refund') throw new Error('refund failed');
        return [1];
      }
    );

    const result = (await handler({ ...baseArg, next: vi.fn(async () => ({ ok: false })) })) as any;

    expect(result.ok).toBe(false);
    expect(scriptOps()).toEqual(['claim', 'refund']);
  });

  it('claims before next() when onlyCountSuccess is unset (default), and never refunds', async () => {
    rateLimit({ limit: 10, period: 60 });
    const handler = capturedHandler.handler!;

    const calls: string[] = [];
    mockEval.mockImplementation(async () => {
      calls.push('claim');
      return [1];
    });
    const next = vi.fn(async () => {
      calls.push('next');
      return { ok: false };
    });

    await handler({ ...baseArg, next });

    expect(calls).toEqual(['claim', 'next']);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimit recordAttempt — round-4 fail-open wrapper', () => {
  it('does NOT throw when hSetWithTTL rejects, and logs sysredis-fail-open with the right context', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;

    const synthetic = new Error('CLUSTERDOWN The cluster is down');
    // The claim script errors, so the call takes the read-then-write path, whose write fails.
    mockEval.mockRejectedValue(new Error('ERR user_script:3: attempt to compare nil with number'));
    mockHSetWithTTL.mockRejectedValueOnce(synthetic);

    const next = vi.fn(async () => ({ ok: true, data: 'still-works' }));

    // The property the audit asked for: a sysRedis failover must NOT
    // 500 the authed mutation.
    const result = (await handler({ ...baseArg, next })) as any;

    expect(result.data).toBe('still-works');
    expect(mockLogSysRedisFailOpen.mock.calls.map((c) => c[0])).toEqual([
      'rate-limit-claim-script-error',
      'rate-limit-write-degraded',
    ]);
    const [subtype, fn, err, extra] = mockLogSysRedisFailOpen.mock.calls[1];
    expect(subtype).toBe('rate-limit-write-degraded');
    expect(fn).toBe('rate-limit-bucket.claimRateLimitAttempt');
    expect(err).toBe(synthetic);
    // The extra payload should carry enough to disambiguate the call. The hash
    // key is namespaced by principal kind (`user:` / `ip:`) so the two key
    // spaces cannot collide — see middleware.trpc.ts and the dedicated bucket-key
    // suite in `middleware.trpc.rate-limit-key.test.ts`.
    // `packed:trpc:limit` is the REAL `REDIS_KEYS.TRPC.LIMIT.BASE`. This asserted
    // `trpc:rate-limit:` for as long as the file supplied its own copy of the constant —
    // both sides of the comparison were the fixture's invention, so it could never fail and
    // never matched production.
    expect(extra).toMatchObject({
      cacheKey: expect.stringContaining('packed:trpc:limit:'),
      hashKey: 'user:42',
    });
  });

  it('moderators short-circuit the entire middleware — no Redis touched at all', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;

    const next = vi.fn(async () => ({ ok: true }));
    await handler({
      ...baseArg,
      ctx: { user: { id: 7, isModerator: true } as any, ip: '127.0.0.1' },
      next,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockHGet).not.toHaveBeenCalled();
    expect(mockHSetWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('over-limit users still throw TOO_MANY_REQUESTS — fail-open is for the WRITE side only', async () => {
    rateLimit({ limit: 1, period: 60 });
    const handler = capturedHandler.handler!;

    // Two recent attempts → already over the per-period limit of 1.
    const recentMs = Date.now() - 5_000;
    mockHGet.mockResolvedValueOnce([recentMs, recentMs]);

    const next = vi.fn(async () => ({ ok: true }));
    await expect(handler({ ...baseArg, next })).rejects.toBeInstanceOf(TRPCError);
    expect(next).not.toHaveBeenCalled();
    // A refusal may write only the active-limit marker, never the attempt bucket.
    const writtenKeys = mockHSetWithTTL.mock.calls.map((call) => String(call[1]));
    expect(writtenKeys.filter((key) => !key.includes('trpc:limit:active:'))).toEqual([]);
  });
});

describe('rateLimit — a refusal decided by the claim script', () => {
  it("carries the rule's own message, as a refusal by the read does", async () => {
    rateLimit({ limit: 2, period: 60, errorMessage: 'Slow down on this one.' });
    const handler = capturedHandler.handler!;
    const now = Date.now();
    // The read saw room; the script, deciding atomically, found the bucket full.
    mockEval.mockResolvedValue([0, now - 2000, now - 1000]);

    const refused = await handler({ ...baseArg, next: vi.fn() }).catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('TOO_MANY_REQUESTS');
    expect((refused as TRPCError).message).toBe('Slow down on this one.');
  });
});

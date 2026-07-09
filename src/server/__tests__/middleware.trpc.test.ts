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

const { mockHSetWithTTL, mockLogSysRedisFailOpen, mockHGet, capturedHandler } = vi.hoisted(() => {
  const captured: { handler: ((arg: unknown) => Promise<unknown>) | null } = { handler: null };
  return {
    mockHSetWithTTL: vi.fn(),
    mockLogSysRedisFailOpen: vi.fn(),
    mockHGet: vi.fn(),
    capturedHandler: captured,
  };
});

vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: mockHSetWithTTL,
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));

vi.mock('~/server/redis/client', () => ({
  redis: {
    packed: {
      hGet: mockHGet,
    },
  },
  REDIS_KEYS: {
    TRPC: { LIMIT: { BASE: 'trpc:rate-limit' } },
  },
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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(async () => undefined),
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

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler.handler = null;
  // No existing attempts — the limit check should pass on every call.
  mockHGet.mockResolvedValue([]);
  mockHSetWithTTL.mockResolvedValue(undefined);
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
  it('writes the attempt AFTER a successful next() when onlyCountSuccess=true', async () => {
    // Construct the middleware — this captures the handler.
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;
    expect(handler).not.toBeNull();

    const next = vi.fn(async () => ({ ok: true, data: 'success', marker: 'next-ran' }));

    const result = (await handler({ ...baseArg, next })) as any;

    expect(next).toHaveBeenCalledTimes(1);
    // hSetWithTTL must run exactly once and only after next() resolved ok.
    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
    // Fail-open logger must NOT have fired on the happy path.
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
    // The original next() result must propagate unchanged.
    expect(result.marker).toBe('next-ran');
  });

  it('SKIPS the attempt write when onlyCountSuccess=true and next() returns ok=false', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;

    const next = vi.fn(async () => ({ ok: false, error: new Error('inner-fail') }));

    const result = (await handler({ ...baseArg, next })) as any;

    expect(next).toHaveBeenCalledTimes(1);
    // The critical assertion — a failed call MUST NOT burn a slot.
    expect(mockHSetWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('writes the attempt BEFORE next() when onlyCountSuccess is unset (default)', async () => {
    rateLimit({ limit: 10, period: 60 });
    const handler = capturedHandler.handler!;

    // Track call order — recordAttempt's hSetWithTTL must fire before next.
    const calls: string[] = [];
    mockHSetWithTTL.mockImplementation(async () => {
      calls.push('record');
    });
    const next = vi.fn(async () => {
      calls.push('next');
      return { ok: true };
    });

    await handler({ ...baseArg, next });

    expect(calls).toEqual(['record', 'next']);
    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('rateLimit recordAttempt — round-4 fail-open wrapper', () => {
  it('does NOT throw when hSetWithTTL rejects, and logs sysredis-fail-open with the right context', async () => {
    rateLimit({ limit: 10, period: 60 }, undefined, { onlyCountSuccess: true });
    const handler = capturedHandler.handler!;

    const synthetic = new Error('CLUSTERDOWN The cluster is down');
    mockHSetWithTTL.mockRejectedValueOnce(synthetic);

    const next = vi.fn(async () => ({ ok: true, data: 'still-works' }));

    // The property the audit asked for: a sysRedis failover must NOT
    // 500 the authed mutation.
    const result = (await handler({ ...baseArg, next })) as any;

    expect(result.data).toBe('still-works');
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, err, extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('rate-limit-write-degraded');
    expect(fn).toBe('middleware.trpc.recordAttempt');
    expect(err).toBe(synthetic);
    // The extra payload should carry enough to disambiguate the call.
    expect(extra).toMatchObject({
      cacheKey: expect.stringContaining('trpc:rate-limit:'),
      hashKey: '42',
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
    expect(mockHSetWithTTL).not.toHaveBeenCalled();
  });
});

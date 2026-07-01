import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the fail-open wrapper added in PR #2332 round-3 audit on
 * `updateSessionState` (the internal helper called by `refreshSession`
 * and `invalidateSession`).
 *
 * The wrapper catches any thrown error from the atomic
 * `hSetMultiWithTTL` helper — sysRedis EVAL failures during a sentinel
 * failover (Phase 4) used to bubble up into the next-auth callback
 * chain and 500 the user-facing request. We now log via
 * `logSysRedisFailOpen` and continue.
 *
 * What we assert here is *boundary behavior*, not the Lua wiring (that
 * lives in src/server/redis/__tests__/atomic.test.ts):
 *   - happy path: helper called once, no fail-open logged, no throw.
 *   - sad path:   helper throws, fail-open is logged with the right
 *                 subtype + fn + context, the outer function does not
 *                 throw.
 *   - empty path: when there are no tokens, neither the helper nor the
 *                 fail-open logger is touched.
 */

const { mockHSetMultiWithTTL, mockLogSysRedisFailOpen, mockHGetAll } = vi.hoisted(() => ({
  mockHSetMultiWithTTL: vi.fn(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockHGetAll: vi.fn(),
}));

vi.mock('~/server/redis/atomic', () => ({
  hSetMultiWithTTL: mockHSetMultiWithTTL,
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: {
    hGetAll: mockHGetAll,
    set: vi.fn().mockResolvedValue('OK'),
  },
  REDIS_KEYS: {
    SESSION: { USER_TOKENS: 'session:user-tokens' },
    USER: { SESSION: 'user:session' },
  },
  REDIS_SYS_KEYS: {
    SESSION: {
      TOKEN_STATE: 'sys:session:token-state',
      ALL: 'sys:session:all',
    },
  },
  withSysReadDeadline: <T>(p: Promise<T>) => p, // transparent in tests (matches rate-limiting.test.ts)
}));

vi.mock('~/server/utils/cache-helpers', () => ({
  clearCacheByPattern: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/utils/signal-client', () => ({
  signalClient: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => vi.fn(),
}));

vi.mock('../session-cache', () => ({
  clearSessionCache: vi.fn().mockResolvedValue(undefined),
}));

// Override the global setup mock of `session-invalidation` (setup.ts mocks
// it for OTHER tests so they don't trip the next-auth chain). We need the
// real module here.
vi.unmock('~/server/auth/session-invalidation');

// Real module under test — imported AFTER the mocks are wired.
import { refreshSession, invalidateSession } from '../session-invalidation';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: user has 2 tokens in the hash.
  mockHGetAll.mockResolvedValue({ 'token-a': 'active', 'token-b': 'active' });
});

describe('updateSessionState fail-open wrapper (via refreshSession)', () => {
  it('happy path: calls hSetMultiWithTTL once with the expected TTL and does not log fail-open', async () => {
    mockHSetMultiWithTTL.mockResolvedValue(undefined);

    await refreshSession(42, { sendSignal: false });

    expect(mockHSetMultiWithTTL).toHaveBeenCalledTimes(1);
    const [, key, fieldsObj, ttlMs] = mockHSetMultiWithTTL.mock.calls[0];
    expect(key).toBe('sys:session:token-state');
    expect(fieldsObj).toEqual({ 'token-a': 'refresh', 'token-b': 'refresh' });
    // 30 days in ms
    expect(ttlMs).toBe(60 * 60 * 24 * 30 * 1000);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('swallows EVAL throws and logs sysredis-fail-open with the right context', async () => {
    const synthetic = new Error("READONLY You can't write against a read only replica.");
    mockHSetMultiWithTTL.mockRejectedValueOnce(synthetic);

    // Must NOT throw — this is the property the PR #2332 audit asked for.
    await expect(refreshSession(42, { sendSignal: false })).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, err, extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('write-degraded');
    expect(fn).toBe('session-invalidation.updateSessionState');
    expect(err).toBe(synthetic);
    expect(extra).toMatchObject({
      userId: 42,
      type: 'refresh',
      tokenCount: 2,
    });
  });

  it('skips both the helper and the fail-open logger when the user has zero tokens', async () => {
    mockHGetAll.mockResolvedValue({});

    await refreshSession(42, { sendSignal: false });

    expect(mockHSetMultiWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});

describe('updateSessionState fail-open wrapper (via invalidateSession)', () => {
  it('does NOT throw on sysRedis failure (security contract was updated in PR #2332)', async () => {
    mockHSetMultiWithTTL.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // The previous contract was "throws on sysRedis unreachable"; the
    // round-3 audit moved this path to fail-open. The read side is
    // already fail-open (token-refresh.ts), so a missed write is
    // symmetric — see updated docstring on invalidateSession.
    await expect(invalidateSession(42)).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][3]).toMatchObject({ type: 'invalid' });
  });
});

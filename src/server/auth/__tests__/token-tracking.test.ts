import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JWT } from 'next-auth/jwt';

/**
 * Tests for the fail-open wrapper added in PR #2332 round-3 audit on
 * `invalidateToken` (called from the next-auth `signOut` event handler).
 *
 * Before the fix, an in-flight EVAL throw during a sysRedis sentinel
 * failover (Phase 4) would propagate up into the next-auth callback
 * chain and 500 the logout request. We now log via
 * `logSysRedisFailOpen` and continue. The downstream `hDel` +
 * `clearSessionCache` calls still run (best-effort cleanup) and are
 * independently wrapped by next-auth's own error handling.
 */

const { mockHSetWithTTL, mockLogSysRedisFailOpen, mockHDel } = vi.hoisted(() => ({
  mockHSetWithTTL: vi.fn(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockHDel: vi.fn(),
}));

vi.mock('~/server/redis/atomic', () => ({
  hSetWithTTL: mockHSetWithTTL,
}));

vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: mockLogSysRedisFailOpen,
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: {
    hDel: mockHDel,
  },
  REDIS_KEYS: { SESSION: { USER_TOKENS: 'session:user-tokens' } },
  REDIS_SYS_KEYS: { SESSION: { TOKEN_STATE: 'sys:session:token-state' } },
}));

vi.mock('~/utils/logging', () => ({
  createLogger: () => vi.fn(),
}));

vi.mock('../session-cache', () => ({
  clearSessionCache: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateToken } from '../token-tracking';

beforeEach(() => {
  vi.clearAllMocks();
  mockHDel.mockResolvedValue(1);
});

function makeToken(overrides: Partial<JWT> = {}): JWT {
  return {
    id: 'token-xyz',
    user: { id: 99 } as any,
    ...overrides,
  } as JWT;
}

describe('invalidateToken fail-open wrapper', () => {
  it('happy path: calls hSetWithTTL once with the expected args and does not log fail-open', async () => {
    mockHSetWithTTL.mockResolvedValue(undefined);

    await invalidateToken(makeToken());

    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
    const [, key, field, value, ttlMs] = mockHSetWithTTL.mock.calls[0];
    expect(key).toBe('sys:session:token-state');
    expect(field).toBe('token-xyz');
    expect(value).toBe('invalid');
    // 30 days in ms
    expect(ttlMs).toBe(60 * 60 * 24 * 30 * 1000);
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('swallows EVAL throws and logs sysredis-fail-open with the right context', async () => {
    const synthetic = new Error('CLUSTERDOWN The cluster is down');
    mockHSetWithTTL.mockRejectedValueOnce(synthetic);

    // Must NOT throw — this is the property the PR #2332 audit asked for.
    await expect(invalidateToken(makeToken())).resolves.toBeUndefined();

    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn, err, extra] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('write-degraded');
    expect(fn).toBe('token-tracking.invalidateToken');
    expect(err).toBe(synthetic);
    expect(extra).toEqual({ tokenId: 'token-xyz' });
  });

  it('continues to the downstream hDel cleanup after the fail-open wrapper swallows', async () => {
    // The wrapper specifically does NOT short-circuit the per-user hDel
    // — best-effort cleanup is preserved even when the marker write fails.
    mockHSetWithTTL.mockRejectedValueOnce(new Error('READONLY'));

    await invalidateToken(makeToken({ user: { id: 99 } as any }));

    expect(mockHDel).toHaveBeenCalledTimes(1);
    expect(mockHDel.mock.calls[0]).toEqual(['session:user-tokens:99', 'token-xyz']);
  });

  it('early-returns on tokens with no id and never touches the helper or the logger', async () => {
    await invalidateToken({} as JWT);
    await invalidateToken({ id: 123 } as unknown as JWT); // non-string id

    expect(mockHSetWithTTL).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });
});

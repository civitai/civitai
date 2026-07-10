import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * STEP-6 sysRedis soft-dependency — the cross-pod orchestrator-token READ in
 * getOrchestratorToken. It already try/catch fail-opens (a fast DOWN falls
 * through to the getTemporaryUserApiKey mint path, logging
 * token-mint-amplification); the gap STEP-6 closes is the missing wall-clock
 * deadline. A silent half-open would otherwise park the awaited hGet ~11min on
 * every authenticated generation call.
 *
 * The SLOW test is fail-on-revert: the underlying hGet NEVER settles, so if the
 * `withSysReadDeadline(...)` wrap were removed the caller would hang → timeout.
 */

const {
  mockHGet,
  mockWithSysReadDeadline,
  mockLogSysRedisFailOpen,
  mockGetOrMint,
  mockGetTempKey,
  mockHSetWithTTL,
} = vi.hoisted(() => ({
  mockHGet: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockGetOrMint: vi.fn(),
  mockGetTempKey: vi.fn(),
  mockHSetWithTTL: vi.fn(async () => undefined),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {},
    sysRedis: { hGet: mockHGet },
    REDIS_KEYS: keyProxy,
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/orchestrator/orchestrator-token-cache', () => ({
  getOrMintCachedToken: mockGetOrMint,
}));
vi.mock('~/server/services/api-key.service', () => ({ getTemporaryUserApiKey: mockGetTempKey }));
vi.mock('~/server/utils/cookie-encryption', () => ({
  getEncryptedCookie: vi.fn(),
  setEncryptedCookie: vi.fn(),
}));

import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';

const ctx = { req: {} as any, res: {} as any };

beforeEach(() => {
  vi.clearAllMocks();
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  // The mint path (used on DOWN/SLOW) — coalesced mint returns a fresh token.
  mockGetOrMint.mockImplementation(async (_userId: number, mint: () => Promise<string>) => mint());
  mockGetTempKey.mockResolvedValue('freshly-minted-token');
  mockHSetWithTTL.mockResolvedValue(undefined);
});

describe('getOrchestratorToken — sysRedis read soft-dependency', () => {
  it('happy path: returns the cached token through withSysReadDeadline, no mint', async () => {
    mockHGet.mockResolvedValue('cached-token');

    const token = await getOrchestratorToken(42, ctx);

    expect(token).toBe('cached-token');
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockGetOrMint).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('DOWN: hGet throws → fails open to the mint path, no throw, logs token-mint-amplification', async () => {
    mockHGet.mockRejectedValue(new Error('sysRedis connection is down'));

    const token = await getOrchestratorToken(42, ctx);

    expect(token).toBe('freshly-minted-token'); // fell through to mint
    expect(mockGetTempKey).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    const [subtype, fn] = mockLogSysRedisFailOpen.mock.calls[0];
    expect(subtype).toBe('token-mint-amplification');
    expect(fn).toBe('getOrchestratorToken hGet');
  });

  it('SLOW/half-open: hGet NEVER settles + deadline REJECTS → fails open to the mint path (fail-on-revert)', async () => {
    mockHGet.mockReturnValue(new Promise(() => undefined));
    mockWithSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));

    const token = await getOrchestratorToken(42, ctx);

    expect(token).toBe('freshly-minted-token');
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockGetTempKey).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen).toHaveBeenCalledTimes(1);
    expect(mockLogSysRedisFailOpen.mock.calls[0][0]).toBe('token-mint-amplification');
  });
});

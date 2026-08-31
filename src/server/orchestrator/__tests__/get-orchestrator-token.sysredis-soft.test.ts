import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  mockObserveMismatch,
} = vi.hoisted(() => ({
  mockHGet: vi.fn(),
  mockWithSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  mockLogSysRedisFailOpen: vi.fn(),
  mockGetOrMint: vi.fn(),
  mockGetTempKey: vi.fn(),
  mockHSetWithTTL: vi.fn(async () => undefined),
  mockObserveMismatch: vi.fn(),
}));

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {},
    sysRedis: { hGet: mockHGet },
    // GENERATION carries the REAL literals rather than the opaque proxy. Which key this module
    // touches is the whole rolling-deploy safety property — an encoded value landing on the key
    // pre-deploy pods read verbatim is a 401 with no self-heal — and under the blanket proxy a
    // read/write pointed at the wrong one passed every test in this file.
    REDIS_KEYS: new Proxy(keyProxy, {
      get: (target, prop) =>
        prop === 'GENERATION'
          ? { TOKENS: 'generation:tokens', TOKENS_OWNED: 'generation:tokens:owned' }
          : Reflect.get(target, prop),
    }),
    withSysReadDeadline: mockWithSysReadDeadline,
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: mockLogSysRedisFailOpen }));
vi.mock('~/server/redis/atomic', () => ({ hSetWithTTL: mockHSetWithTTL }));
vi.mock('~/server/orchestrator/orchestrator-token-cache', () => ({
  getOrMintCachedToken: mockGetOrMint,
}));
vi.mock('~/server/services/api-key.service', () => ({ getTemporaryUserApiKey: mockGetTempKey }));
vi.mock('~/server/orchestrator/orchestrator-identity-metrics', () => ({
  observeTokenIdentityMismatch: mockObserveMismatch,
}));

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

const mockLogToAxiom = loggingMock.logToAxiom;

const ctx = { req: {} as any, res: {} as any };

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 PIN THE MODE. `get-orchestrator-token.ts` short-circuits on
  // `env.ORCHESTRATOR_MODE === 'dev'` and returns the static
  // ORCHESTRATOR_ACCESS_TOKEN without ever reaching sysRedis — which is the
  // entire path this file tests. That branch used to be unreachable here only
  // BY ACCIDENT: ORCHESTRATOR_MODE was missing from the hand-enumerated
  // TEST_ENV_DEFAULTS, so it read `undefined`. Once the defaults were derived
  // from the schema (which declares `.default('dev')`) the accident ended and
  // all three cases returned 'test-orchestrator-token'. Pin it explicitly so
  // the suite states what it depends on instead of inheriting a gap.
  setEnv({ ORCHESTRATOR_MODE: 'prod' });
  mockWithSysReadDeadline.mockImplementation((p) => p); // transparent by default
  // The mint path (used on DOWN/SLOW) — coalesced mint returns a fresh token.
  mockGetOrMint.mockImplementation(async (_userId: number, mint: () => Promise<string>) => mint());
  mockGetTempKey.mockResolvedValue('freshly-minted-token');
  mockHSetWithTTL.mockResolvedValue(undefined);
});

describe('getOrchestratorToken — sysRedis read soft-dependency', () => {
  it('happy path: returns the cached token through withSysReadDeadline, no mint', async () => {
    // Cached values carry their owner (`<userId>.<token>`) so the hit can be
    // verified — see orchestrator-token-identity.ts.
    mockHGet.mockResolvedValue('42.cached-token');

    const token = await getOrchestratorToken(42, ctx);

    expect(token).toBe('cached-token');
    expect(mockWithSysReadDeadline).toHaveBeenCalledTimes(1);
    expect(mockGetOrMint).not.toHaveBeenCalled();
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
    expect(mockObserveMismatch).not.toHaveBeenCalled();
  });

  // The 2026-08-30 failure reduced to its one decisive assertion: whatever put a
  // stranger's bearer in this user's hash field, it must not be what the orchestrator
  // is handed. A revert returns 'someone-elses-token' here, which is a cross-account
  // Buzz charge in prod. (Ids synthetic — the real ones name real accounts.)
  it('MISMATCH: a field holding another user’s token is refused, alarmed, and re-minted', async () => {
    mockHGet.mockResolvedValue('2002.someone-elses-token');

    const token = await getOrchestratorToken(1001, ctx);

    expect(token).toBe('freshly-minted-token');
    expect(token).not.toContain('someone-elses-token');
    // The re-mint must be for the CALLER, not the owner the poisoned value named — the last
    // remaining way this function could hand back a stranger's identity.
    expect(mockGetOrMint).toHaveBeenCalledWith(1001, expect.any(Function));
    expect(mockObserveMismatch).toHaveBeenCalledTimes(1);
    expect(mockObserveMismatch).toHaveBeenCalledWith('redis');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator-token-identity-mismatch',
        userId: 1001,
        ownerId: '2002',
      })
    );
    // NOT a sysRedis fault — it must not be filed as one.
    expect(mockLogSysRedisFailOpen).not.toHaveBeenCalled();
  });

  it('UNOWNED: an unprefixed value re-mints silently, without firing the alarm', async () => {
    mockHGet.mockResolvedValue('bare-token-from-an-untaught-writer');

    expect(await getOrchestratorToken(42, ctx)).toBe('freshly-minted-token');
    expect(mockObserveMismatch).not.toHaveBeenCalled();
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('decodes a Buffer reply — the Sentinel sysRedis path returns BLOB_STRINGs as Buffers', async () => {
    mockHGet.mockResolvedValue(Buffer.from('42.cached-token', 'utf8'));

    expect(await getOrchestratorToken(42, ctx)).toBe('cached-token');
    expect(mockGetOrMint).not.toHaveBeenCalled();
  });

  it('writes the token back bound to its owner, so the next read can verify it', async () => {
    mockHGet.mockResolvedValue(null);

    await getOrchestratorToken(42, ctx);

    expect(mockHSetWithTTL).toHaveBeenCalledTimes(1);
    expect(mockHSetWithTTL).toHaveBeenCalledWith(
      expect.anything(),
      // The OWNED key, named literally. The encoded value must never land on `generation:tokens`,
      // which pods on an older build read straight through as a bearer.
      'generation:tokens:owned',
      '42',
      '42.freshly-minted-token',
      expect.any(Number)
    );
  });

  it('READS the owned key too — a read/write key split would silently mint on every call', async () => {
    mockHGet.mockResolvedValue('42.cached-token');

    await getOrchestratorToken(42, ctx);

    expect(mockHGet).toHaveBeenCalledWith('generation:tokens:owned', '42');
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

describe('getOrchestratorToken — cross-user mint (moderator bypassCache)', () => {
  // Two properties, not one. Skipping the per-pod LRU was the original point; binding the
  // encoding to the TARGET user is new, and getting it wrong here would write a moderator-owned
  // token under a target's field — the exact shape of the fault this whole change exists to catch.
  it('skips the per-pod cache AND writes back bound to the TARGET user', async () => {
    mockHGet.mockResolvedValue(null);

    const token = await getOrchestratorToken(777, ctx, { bypassCache: true });

    expect(token).toBe('freshly-minted-token');
    expect(mockGetOrMint).not.toHaveBeenCalled();
    expect(mockGetTempKey).toHaveBeenCalledWith(expect.objectContaining({ userId: 777 }));
    expect(mockHSetWithTTL).toHaveBeenCalledWith(
      expect.anything(),
      'generation:tokens:owned',
      '777',
      '777.freshly-minted-token',
      expect.any(Number)
    );
  });
});

afterAll(() => {
  resetEnv();
});

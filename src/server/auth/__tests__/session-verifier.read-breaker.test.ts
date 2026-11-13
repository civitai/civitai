import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import { envMock, redisMock } from '~/__tests__/mocks';

// The revocation read runs on every authenticated request, so it opts into the sys read breaker. With the
// breaker enabled and tripped, a hung store costs this read ~0ms instead of a deadline per request. Uses the
// REAL withSysReadBreaker (the canonical seam's default) over a sysRedis that never answers.

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));

const observeSessionLeg = vi.hoisted(() => vi.fn());
const observeRevocationDegraded = vi.hoisted(() => vi.fn());
vi.mock('../session-metrics', () => ({ observeSessionLeg, observeRevocationDegraded }));

import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { isRevoked } from '../session-verifier';

const THRESHOLD = 3; // not the default 5
const claims = { jti: 't7', sub: '7', signedAt: 1000, user: { id: 7 } } as unknown as SessionClaims;
const hangStore = () => {
  redisMock.sysRedis.hGet.mockReturnValue(new Promise(() => undefined));
  redisMock.sysRedis.get.mockReturnValue(new Promise(() => undefined));
};

afterEach(() => {
  observeSessionLeg.mockClear();
  observeRevocationDegraded.mockClear();
  globalThis.__civitaiSysReadBreaker?.reset();
  envMock.reset();
});

describe('isRevoked over a hung store', () => {
  it('with the breaker enabled and tripped, fails open at once instead of waiting its deadline', async () => {
    hangStore();
    envMock.set({
      REDIS_SYS_READ_BREAKER_ENABLED: true,
      REDIS_SYS_READ_BREAKER_THRESHOLD: THRESHOLD,
      REDIS_SYS_READ_BREAKER_COOLDOWN_MS: 60_000,
      REDIS_SYS_READ_TIMEOUT_MS: 20,
    });
    for (let i = 0; i < THRESHOLD; i++) expect(await isRevoked(claims)).toBe(false);
    expect(observeSessionLeg.mock.calls.map((c) => c.slice(0, 2))).toEqual(
      Array(THRESHOLD).fill(['revocation', 'timeout'])
    );

    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 3000 });
    const started = Date.now();
    expect(await isRevoked(claims)).toBe(false);
    // Only the tripped breaker returns before the 3s deadline.
    expect(Date.now() - started).toBeLessThan(500);
    // ...and the revocation leg records it as its own outcome, not as an error.
    expect(observeSessionLeg).toHaveBeenLastCalledWith(
      'revocation',
      'breaker-open',
      expect.any(Number)
    );
  }, 10_000);

  it('with the breaker off (the default), each read still waits out its deadline', async () => {
    hangStore();
    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 20 });
    for (let i = 0; i < THRESHOLD * 2; i++) expect(await isRevoked(claims)).toBe(false);

    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 150 });
    const started = Date.now();
    expect(await isRevoked(claims)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(130);
  });

  it('with the breaker tripped, a revocation this process read before the outage still denies', async () => {
    // A healthy read first: the store says this session was signed out.
    const revoked = { ...claims, jti: 'signed-out' } as SessionClaims;
    redisMock.sysRedis.hGet.mockImplementation(async (key: string, field: string) =>
      key === REDIS_SYS_KEYS.SESSION.TOKEN_STATE && field === 'signed-out' ? 'invalid' : null
    );
    redisMock.sysRedis.get.mockResolvedValue(null);
    envMock.set({
      REDIS_SYS_READ_BREAKER_ENABLED: true,
      REDIS_SYS_READ_BREAKER_THRESHOLD: THRESHOLD,
      REDIS_SYS_READ_BREAKER_COOLDOWN_MS: 60_000,
      REDIS_SYS_READ_TIMEOUT_MS: 20,
    });
    expect(await isRevoked(revoked)).toBe(true);

    // Then the store hangs until the breaker trips.
    hangStore();
    for (let i = 0; i < THRESHOLD; i++) await isRevoked(claims);
    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 3000 });
    const started = Date.now();
    expect(await isRevoked(revoked)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(observeSessionLeg).toHaveBeenLastCalledWith(
      'revocation',
      'breaker-open',
      expect.any(Number)
    );
    expect(observeRevocationDegraded).toHaveBeenLastCalledWith('deny_cached');
  }, 10_000);
});

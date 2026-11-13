import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';

// Leg 3 of the SPOF fix: the sysRedis revocation read (the shared createRevocationCheck) is bounded by
// withSysReadBreaker and FAILS OPEN on a timeout (a revocation-check stall must never block login), while emitting the revocation-leg metric.
const h = vi.hoisted(() => ({
  observeSessionLeg: vi.fn(),
  observeRevocationDegraded: vi.fn(),
  hGet: vi.fn(),
  get: vi.fn(),
  withSysReadBreaker: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  logSysRedisFailOpen: vi.fn(),
}));

// session-verifier constructs an AuthVerifier at module load — stub the package (we only exercise isRevoked).
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));
vi.mock('~/server/auth/session-metrics', () => ({
  observeSessionLeg: h.observeSessionLeg,
  observeRevocationDegraded: h.observeRevocationDegraded,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: h.logSysRedisFailOpen }));
// 🔴 Spread the REAL package for the key constants rather than re-typing them. Hand-typed
// copies drift silently: this factory used to declare TOKEN_STATE as 'sys:token-state' and
// ALL as 'sys:all' while production uses 'session:token-state' and 'session:all', so the
// suite exercised keys Redis never sees and could not have caught a key-name regression.
// The client and the withSysReadBreaker control surface stay overridden.
vi.mock('~/server/redis/client', async () => ({
  ...(await import('@civitai/redis/client')),
  sysRedis: { hGet: h.hGet, get: h.get },
  withSysReadBreaker: h.withSysReadBreaker,
}));

import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { envMock } from '~/__tests__/mocks';
import type * as Verifier from '../session-verifier';

// Loaded fresh per test: the shared check keeps the revocation markers it has read, so a marker one test
// returns would otherwise decide another test's verdict when its read fails.
let isRevoked: typeof Verifier.isRevoked;

const claims = (over: Partial<SessionClaims> = {}): SessionClaims =>
  ({ jti: 't7', signedAt: 1000, ...over } as SessionClaims);

beforeEach(async () => {
  vi.clearAllMocks();
  h.withSysReadBreaker.mockImplementation((p) => p); // transparent by default
  h.hGet.mockResolvedValue(null);
  h.get.mockResolvedValue(null);
  vi.resetModules();
  ({ isRevoked } = await import('../session-verifier'));
});

afterEach(() => envMock.reset());

describe('isRevoked — bounded revocation read (leg 3)', () => {
  it('returns false and records outcome "hit" when the token is not revoked', async () => {
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'hit', expect.any(Number));
  });

  it('returns true when TOKEN_STATE is "invalid" (explicit logout/ban)', async () => {
    h.hGet.mockResolvedValue('invalid');
    expect(await isRevoked(claims())).toBe(true);
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'hit', expect.any(Number));
  });

  it('returns true when a global SESSION.ALL cutoff is newer than the token', async () => {
    h.get.mockResolvedValue(new Date(5000).toISOString()); // cutoff 5000 > signedAt 1000
    expect(await isRevoked(claims({ signedAt: 1000 }))).toBe(true);
  });

  it("returns true when the user's cut is newer than the token, and not for one signed after it", async () => {
    h.get.mockImplementation(async (key: string) =>
      key === `${REDIS_SYS_KEYS.SESSION.USER_CUT}:7` ? '5000' : null
    );
    expect(await isRevoked(claims({ sub: '7', signedAt: 1000 }))).toBe(true);
    expect(await isRevoked(claims({ sub: '7', signedAt: 6000 }))).toBe(false);
  });

  it("returns true for an impersonation token when the moderator's cut is newer", async () => {
    h.get.mockImplementation(async (key: string) =>
      key === `${REDIS_SYS_KEYS.SESSION.USER_CUT}:100` ? '5000' : null
    );
    expect(await isRevoked(claims({ sub: '7', impersonatedBy: 100, signedAt: 1000 }))).toBe(true);
    expect(await isRevoked(claims({ sub: '7', signedAt: 1000 }))).toBe(false);
  });

  it("returns true when the token's family is invalid", async () => {
    h.hGet.mockImplementation(async (key: string, field: string) =>
      key === REDIS_SYS_KEYS.SESSION.FAMILY_STATE && field === 'root' ? 'invalid' : null
    );
    expect(await isRevoked(claims({ sid: 'root' }))).toBe(true);
    expect(await isRevoked(claims({ sid: 'other' }))).toBe(false);
  });

  it('FAILS OPEN (false) on a read-deadline timeout and records outcome "timeout"', async () => {
    // withSysReadBreaker rejects with an error tagged `reason: 'timeout'` when the deadline trips.
    h.withSysReadBreaker.mockRejectedValue(
      Object.assign(new Error('sysRedis read timed out after 1000ms'), { reason: 'timeout' })
    );
    expect(await isRevoked(claims())).toBe(false); // a stalled revocation check must NOT block login
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'timeout', expect.any(Number));
    expect(h.observeRevocationDegraded).toHaveBeenCalledWith('allow_unknown');
    expect(h.logSysRedisFailOpen).toHaveBeenCalledWith(
      'read-degraded',
      'session-verifier isRevoked',
      expect.any(Error),
      expect.objectContaining({ tokenId: 't7', verdict: 'allow_unknown' })
    );
  });

  it('FAILS OPEN (false) on a generic read error and records outcome "error"', async () => {
    h.withSysReadBreaker.mockRejectedValue(new Error('ECONNRESET'));
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'error', expect.any(Number));
  });

  it.each([
    ['a read error', () => h.withSysReadBreaker.mockRejectedValue(new Error('ECONNRESET'))],
    [
      'an open read breaker',
      () =>
        h.withSysReadBreaker.mockRejectedValue(
          Object.assign(new Error('sys read breaker open'), { reason: 'breaker-open' })
        ),
    ],
  ])(
    'still DENIES on %s a token whose revocation this process has already read',
    async (_name, fail) => {
      h.hGet.mockImplementation(async (key: string, field: string) =>
        key === REDIS_SYS_KEYS.SESSION.TOKEN_STATE && field === 't7' ? 'invalid' : null
      );
      expect(await isRevoked(claims())).toBe(true);

      fail();
      expect(await isRevoked(claims())).toBe(true);
      expect(h.observeRevocationDegraded).toHaveBeenCalledWith('deny_cached');
      expect(h.logSysRedisFailOpen).toHaveBeenCalledWith(
        'read-degraded',
        'session-verifier isRevoked',
        expect.any(Error),
        expect.objectContaining({ verdict: 'deny_cached' })
      );
      // A token this process never saw revoked is still allowed (the fail-open policy).
      expect(await isRevoked(claims({ jti: 'unseen' }))).toBe(false);
      expect(h.observeRevocationDegraded).toHaveBeenLastCalledWith('allow_unknown');
    }
  );

  it('with SESSION_REVOCATION_CACHE off, a failed read fails open even for a revocation already read', async () => {
    envMock.set({ SESSION_REVOCATION_CACHE: false });
    vi.resetModules();
    ({ isRevoked } = await import('../session-verifier'));
    h.hGet.mockImplementation(async (key: string, field: string) =>
      key === REDIS_SYS_KEYS.SESSION.TOKEN_STATE && field === 't7' ? 'invalid' : null
    );
    expect(await isRevoked(claims())).toBe(true);

    h.withSysReadBreaker.mockRejectedValue(new Error('ECONNRESET'));
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeRevocationDegraded).toHaveBeenCalledWith('allow_unknown');
  });

  it('returns false without reading when the token has no jti', async () => {
    expect(await isRevoked(claims({ jti: undefined }))).toBe(false);
    expect(h.withSysReadBreaker).not.toHaveBeenCalled();
    expect(h.observeSessionLeg).not.toHaveBeenCalled();
  });
});

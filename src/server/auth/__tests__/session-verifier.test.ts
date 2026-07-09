import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionClaims } from '@civitai/auth';

// Leg 3 of the SPOF fix: the sysRedis revocation read is now bounded by withSysReadDeadline and FAILS OPEN on
// a timeout (a revocation-check stall must never block login), while emitting the revocation-leg metric.
const h = vi.hoisted(() => ({
  observeSessionLeg: vi.fn(),
  hGet: vi.fn(),
  get: vi.fn(),
  withSysReadDeadline: vi.fn<(p: Promise<unknown>) => Promise<unknown>>(),
  logSysRedisFailOpen: vi.fn(),
}));

// session-verifier constructs an AuthVerifier at module load — stub the package (we only exercise isRevoked).
vi.mock('@civitai/auth', () => ({ createAuthVerifier: () => ({}) }));
vi.mock('~/server/auth/session-metrics', () => ({ observeSessionLeg: h.observeSessionLeg }));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: h.logSysRedisFailOpen }));
vi.mock('~/server/redis/client', () => ({
  sysRedis: { hGet: h.hGet, get: h.get },
  REDIS_SYS_KEYS: { SESSION: { TOKEN_STATE: 'sys:token-state', ALL: 'sys:all' } },
  withSysReadDeadline: h.withSysReadDeadline,
}));

import { isRevoked } from '../session-verifier';

const claims = (over: Partial<SessionClaims> = {}): SessionClaims =>
  ({ jti: 't7', signedAt: 1000, ...over } as SessionClaims);

beforeEach(() => {
  vi.clearAllMocks();
  h.withSysReadDeadline.mockImplementation((p) => p); // transparent by default
  h.hGet.mockResolvedValue(null);
  h.get.mockResolvedValue(null);
});

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

  it('FAILS OPEN (false) on a read-deadline timeout and records outcome "timeout"', async () => {
    // withSysReadDeadline rejects with a "…read timed out after Nms" Error when the deadline trips.
    h.withSysReadDeadline.mockRejectedValue(new Error('sysRedis read timed out after 2000ms'));
    expect(await isRevoked(claims())).toBe(false); // a stalled revocation check must NOT block login
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'timeout', expect.any(Number));
    expect(h.logSysRedisFailOpen).toHaveBeenCalled();
  });

  it('FAILS OPEN (false) on a generic read error and records outcome "error"', async () => {
    h.withSysReadDeadline.mockRejectedValue(new Error('ECONNRESET'));
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeSessionLeg).toHaveBeenCalledWith('revocation', 'error', expect.any(Number));
  });

  it('returns false without reading when the token has no jti', async () => {
    expect(await isRevoked(claims({ jti: undefined }))).toBe(false);
    expect(h.withSysReadDeadline).not.toHaveBeenCalled();
    expect(h.observeSessionLeg).not.toHaveBeenCalled();
  });
});

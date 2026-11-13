import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';

// A revocation this pod has already read must still hold while sysRedis is down. Before the marker cache,
// every sysRedis failure answered "not revoked", so a signed-out or banned session kept working for the
// whole outage. A session with no known marker still fails open (logging everyone out during an outage is
// not the policy), but that verdict is now counted.
const h = vi.hoisted(() => ({
  observeSessionLeg: vi.fn(),
  observeRevocationDegraded: vi.fn(),
  logSysRedisFailOpen: vi.fn(),
}));

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));
vi.mock('~/server/auth/session-metrics', () => ({
  observeSessionLeg: h.observeSessionLeg,
  observeRevocationDegraded: h.observeRevocationDegraded,
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: h.logSysRedisFailOpen }));

import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as Verifier from '../session-verifier';

let isRevoked: typeof Verifier.isRevoked;

// The canonical redis mock (src/__tests__/setup.ts) supplies sysRedis with the real key constants, and
// the `withSysReadDeadline` seam that injects a read failure.
const sys = {
  hGet: redisMock.sysRedis.hGet,
  get: redisMock.sysRedis.get,
  withSysReadDeadline: redisMock.withSysReadDeadline,
};

const claims = (over: Partial<SessionClaims> = {}): SessionClaims =>
  ({ jti: 't7', sub: '7', signedAt: 1000, ...over } as SessionClaims);

const USER_CUT_7 = `${REDIS_SYS_KEYS.SESSION.USER_CUT}:7`;
const TOKEN_STATE = REDIS_SYS_KEYS.SESSION.TOKEN_STATE;
const FAMILY_STATE = REDIS_SYS_KEYS.SESSION.FAMILY_STATE;
const ALL = REDIS_SYS_KEYS.SESSION.ALL;

// The real deadline's shape (`sys-read-deadline.ts`), shortened: race the read against a timer.
const deadline =
  (ms: number) =>
  (p: Promise<unknown>): Promise<unknown> =>
    Promise.race([
      p,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`sysRedis read timed out after ${ms}ms`)), ms)
      ),
    ]);

/** sysRedis answers every read with a rejection. */
function sysRedisRejects() {
  sys.withSysReadDeadline.mockImplementation((p: Promise<unknown>) => {
    p.catch(() => undefined);
    return Promise.reject(new Error('ECONNREFUSED'));
  });
  sys.hGet.mockRejectedValue(new Error('ECONNREFUSED'));
  sys.get.mockRejectedValue(new Error('ECONNREFUSED'));
}

/** sysRedis accepts the reads and never answers; the deadline is what ends the wait. */
function sysRedisNeverSettles() {
  sys.withSysReadDeadline.mockImplementation(deadline(20));
  sys.hGet.mockImplementation(() => new Promise(() => undefined));
  sys.get.mockImplementation(() => new Promise(() => undefined));
}

const outages = [
  ['rejects', sysRedisRejects],
  ['never settles', sysRedisNeverSettles],
] as const;

beforeEach(async () => {
  vi.clearAllMocks();
  sys.withSysReadDeadline.mockImplementation((p: Promise<unknown>) => p);
  sys.hGet.mockResolvedValue(null);
  sys.get.mockResolvedValue(null);
  // A fresh module per test, so markers seen by one test are not known to the next.
  vi.resetModules();
  ({ isRevoked } = await import('../session-verifier'));
});

describe.each(outages)('isRevoked while sysRedis %s', (_name, outage) => {
  it('still denies a signed-out token whose marker this pod has read', async () => {
    sys.hGet.mockImplementation(async (key: string, field: string) =>
      key === TOKEN_STATE && field === 't7' ? 'invalid' : null
    );
    expect(await isRevoked(claims())).toBe(true);

    outage();
    expect(await isRevoked(claims())).toBe(true);
    expect(h.observeRevocationDegraded).toHaveBeenCalledWith('deny_cached');
  });

  it("still denies a banned user's earlier token once this pod has read the user's cut", async () => {
    // The ban writes the user's cut; any read for that user returns it, whichever token asked.
    sys.get.mockImplementation(async (key: string) => (key === USER_CUT_7 ? '5000' : null));
    expect(await isRevoked(claims({ jti: 'other', signedAt: 6000 }))).toBe(false);

    outage();
    expect(await isRevoked(claims({ jti: 'pre-ban', signedAt: 1000 }))).toBe(true);
    // The same predicate decides: a token signed after the cut is not revoked by it.
    expect(await isRevoked(claims({ jti: 'post-ban', signedAt: 6000 }))).toBe(false);
  });

  it('still denies a token from a signed-out family whose marker this pod has read', async () => {
    sys.hGet.mockImplementation(async (key: string, field: string) =>
      key === FAMILY_STATE && field === 'root' ? 'invalid' : null
    );
    expect(await isRevoked(claims({ sid: 'root' }))).toBe(true);

    outage();
    expect(await isRevoked(claims({ jti: 'sibling', sid: 'root' }))).toBe(true);
    expect(await isRevoked(claims({ jti: 'unrelated', sid: 'other' }))).toBe(false);
  });

  it('still applies a global cut-off this pod has read', async () => {
    sys.get.mockImplementation(async (key: string) =>
      key === ALL ? new Date(5000).toISOString() : null
    );
    expect(await isRevoked(claims({ signedAt: 6000 }))).toBe(false);

    outage();
    expect(await isRevoked(claims({ jti: 'old', signedAt: 1000 }))).toBe(true);
  });

  it('allows a session with no known marker, and counts and logs that verdict', async () => {
    // POLICY PIN: no marker known means fail open, as before the cache. Failing closed here would sign
    // every user out for the length of an outage.
    outage();
    expect(await isRevoked(claims({ jti: 'never-seen', sub: '99' }))).toBe(false);
    expect(h.observeRevocationDegraded).toHaveBeenCalledWith('allow_unknown');
    expect(h.observeRevocationDegraded).toHaveBeenCalledTimes(1);
    expect(h.logSysRedisFailOpen).toHaveBeenCalledTimes(1);
  });

  it('forgets a marker that a later healthy read no longer returns', async () => {
    sys.get.mockResolvedValueOnce(null).mockResolvedValueOnce('5000'); // ALL, then the user's cut
    expect(await isRevoked(claims())).toBe(true);
    sys.get.mockResolvedValue(null);
    expect(await isRevoked(claims())).toBe(false);

    outage();
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeRevocationDegraded).toHaveBeenCalledWith('allow_unknown');
  });
});

describe('isRevoked with sysRedis healthy', () => {
  it('answers from sysRedis, not from a marker it read earlier', async () => {
    sys.hGet.mockResolvedValueOnce('invalid');
    expect(await isRevoked(claims())).toBe(true);
    // sysRedis no longer has it (e.g. the marker expired): the healthy path follows sysRedis.
    expect(await isRevoked(claims())).toBe(false);
    expect(h.observeRevocationDegraded).not.toHaveBeenCalled();
  });

  it('does not read sysRedis more than before', async () => {
    await isRevoked(claims({ sid: 'root', impersonatedBy: 100 }));
    // token state + family state, and ALL + user cut + impersonator user cut + impersonation cut.
    expect(sys.hGet).toHaveBeenCalledTimes(2);
    expect(sys.get).toHaveBeenCalledTimes(4);
    expect(sys.withSysReadDeadline).toHaveBeenCalledTimes(1);
  });
});

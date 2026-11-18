import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type { SessionClaims } from '@civitai/auth';
import type * as SessionMetrics from '../session-metrics';

// The guards capture Date.now when their module is evaluated, so the fake clock goes in before any import.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  createAuthVerifier: () => ({}),
}));

const observeSessionLeg = vi.hoisted(() => vi.fn());
vi.mock('../session-metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionMetrics>()),
  observeSessionLeg,
}));

import { REDIS_SYS_KEYS } from '@civitai/redis/client';
import { envMock, redisMock } from '~/__tests__/mocks';
import {
  sysReadBreakerTransitionCounter,
  sysReadGuardRejectionCounter,
} from '~/server/prom/sys-read-guard.metrics';
import { withSysReadBreaker } from '~/server/redis/sys-read-deadline';

// This file is about the breakers alone, so the seen-marker fallback is off. With it on, a read the
// breaker abandoned still settles into the record, and a later failed read denies from it; that would
// pass the isolation case below even with the revocation read back on the shared breaker. The fallback
// is read once when the check is built, so it is set before the verifier is loaded.
envMock.set({ SESSION_REVOCATION_CACHE: false });
const { isRevoked } = await import('../session-verifier');

// The revocation read must not share a breaker with the other hot sys reads: a breaker opened by THEIR
// failures would refuse the revocation read while the store still answers, and a revoked session would be
// accepted. Everything below runs the real guards over the canonical sysRedis mock.

const THRESHOLD = 3; // not the default 5
const OVERSHOOT = THRESHOLD + 2;
const COOLDOWN_MS = 60_000; // not the default 5000

const signedOut = {
  jti: 'signed-out',
  sub: '7',
  signedAt: 1000,
  user: { id: 7 },
} as unknown as SessionClaims;

const breakerOn = () =>
  envMock.set({
    REDIS_SYS_READ_BREAKER_ENABLED: true,
    REDIS_SYS_READ_BREAKER_THRESHOLD: THRESHOLD,
    REDIS_SYS_READ_BREAKER_COOLDOWN_MS: COOLDOWN_MS,
    REDIS_SYS_READ_TIMEOUT_MS: 1000,
  });

/** A store that answers, holding a sign-out marker for `signedOut`. */
const storeAnswers = () => {
  redisMock.sysRedis.hGet.mockImplementation(async (key: string, field: string) =>
    key === REDIS_SYS_KEYS.SESSION.TOKEN_STATE && field === 'signed-out' ? 'invalid' : null
  );
  redisMock.sysRedis.get.mockResolvedValue(null);
};

/** A store the client cannot reach: every read fails with a connection error. */
const storeErrors = () => {
  redisMock.sysRedis.hGet.mockRejectedValue(new Error('ECONNRESET'));
  redisMock.sysRedis.get.mockRejectedValue(new Error('ECONNRESET'));
};

const outcomes = () => observeSessionLeg.mock.calls.map((c) => c[1]);
const lastOutcome = () => observeSessionLeg.mock.calls.at(-1)?.slice(0, 2);

/** Fails `n` reads that are not the revocation read, through the shared breaker. */
const failSharedReads = async (n: number) => {
  for (let i = 0; i < n; i++)
    await expect(
      withSysReadBreaker(Promise.reject(new Error('ECONNRESET')), 1000)
    ).rejects.toBeInstanceOf(Error);
};
const sharedRead = () => withSysReadBreaker(Promise.resolve('through'), 1000);

const tripRevocationBreaker = async () => {
  storeErrors();
  for (let i = 0; i < THRESHOLD; i++) expect(await isRevoked(signedOut)).toBe(false);
  expect(outcomes()).toEqual(Array(THRESHOLD).fill('error'));
};

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

afterEach(() => {
  observeSessionLeg.mockClear();
  globalThis.__civitaiSysReadBreaker?.reset();
  globalThis.__civitaiRevocationReadBreaker?.reset();
  envMock.reset();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('the session revocation read breaker', () => {
  it('still reads, and denies a revoked session, while the shared breaker is open', async () => {
    breakerOn();
    storeAnswers();
    await failSharedReads(OVERSHOOT);
    // Positive control: the shared breaker really is open.
    await expect(sharedRead()).rejects.toMatchObject({ reason: 'breaker-open' });

    expect(await isRevoked(signedOut)).toBe(true);
    expect(lastOutcome()).toEqual(['revocation', 'hit']);
  });

  it('opens on revocation-read failures, and those failures leave the shared breaker closed', async () => {
    breakerOn();
    await tripRevocationBreaker();

    // Open: refused without waiting, so the check fails open even though the store answers again.
    storeAnswers();
    expect(await isRevoked(signedOut)).toBe(false);
    expect(lastOutcome()).toEqual(['revocation', 'breaker-open']);

    await expect(sharedRead()).resolves.toBe('through');
  });

  it('lets one probe through after the cooldown, and closes when it succeeds', async () => {
    breakerOn();
    await tripRevocationBreaker();
    storeAnswers();

    advance(COOLDOWN_MS - 1);
    expect(await isRevoked(signedOut)).toBe(false);
    expect(lastOutcome()).toEqual(['revocation', 'breaker-open']);

    advance(2);
    expect(await isRevoked(signedOut)).toBe(true);
    expect(lastOutcome()).toEqual(['revocation', 'hit']);
    expect(await isRevoked(signedOut)).toBe(true);
    expect(lastOutcome()).toEqual(['revocation', 'hit']);
  });

  it('re-opens for another cooldown when the probe fails', async () => {
    breakerOn();
    await tripRevocationBreaker();

    advance(COOLDOWN_MS + 1);
    expect(await isRevoked(signedOut)).toBe(false);
    expect(lastOutcome()).toEqual(['revocation', 'error']);

    storeAnswers();
    expect(await isRevoked(signedOut)).toBe(false);
    expect(lastOutcome()).toEqual(['revocation', 'breaker-open']);
  });

  it('with the breaker off (the default), neither breaker ever opens', async () => {
    envMock.set({ REDIS_SYS_READ_TIMEOUT_MS: 1000 });
    storeErrors();
    for (let i = 0; i < OVERSHOOT; i++) expect(await isRevoked(signedOut)).toBe(false);
    await failSharedReads(OVERSHOOT);

    storeAnswers();
    expect(await isRevoked(signedOut)).toBe(true);
    expect(outcomes()).not.toContain('breaker-open');
    await expect(sharedRead()).resolves.toBe('through');
  });

  it("labels the revocation breaker's transitions and rejections apart from the shared breaker's", async () => {
    const count = async (
      counter: typeof sysReadBreakerTransitionCounter | typeof sysReadGuardRejectionCounter,
      labels: Record<string, string>
    ) =>
      (await counter.get()).values
        .filter((v) =>
          Object.entries(labels).every(
            ([k, want]) => (v.labels as Record<string, unknown>)[k] === want
          )
        )
        .reduce((sum, v) => sum + v.value, 0);
    const snapshot = async () => ({
      revocationOpened: await count(sysReadBreakerTransitionCounter, {
        guard: 'revocation',
        to: 'open',
      }),
      sharedOpened: await count(sysReadBreakerTransitionCounter, { guard: 'shared', to: 'open' }),
      revocationRefused: await count(sysReadGuardRejectionCounter, {
        guard: 'revocation',
        reason: 'breaker-open',
      }),
      sharedRefused: await count(sysReadGuardRejectionCounter, {
        guard: 'shared',
        reason: 'breaker-open',
      }),
    });

    breakerOn();
    const before = await snapshot();
    await tripRevocationBreaker();
    await isRevoked(signedOut);
    await isRevoked(signedOut);

    expect(await snapshot()).toEqual({
      revocationOpened: before.revocationOpened + 1,
      sharedOpened: before.sharedOpened,
      revocationRefused: before.revocationRefused + 2,
      sharedRefused: before.sharedRefused,
    });
  });
});

import { describe, expect, test } from 'vitest';
import {
  MAX_REFRESH_RETRIES,
  REFRESH_RETRY_BACKOFF_MS,
  TERMINAL_MINT_STATUSES,
  decideRefreshRetry,
  isTerminalMintStatus,
  msUntilExpiry,
  shouldRetainTokenOnFailure,
} from '~/components/AppBlocks/blockTokenRetry';

/**
 * Bounds + retention rules for `useBlockToken`'s refresh-failure recovery.
 *
 * These are the cheap, exhaustive, node-env half of the coverage. The hook
 * itself — the REAL path, with real React, real timers and a real fetch
 * boundary — is driven in `useBlockToken.browser.test.tsx`; a suite that only
 * exercised these pure functions would prove the rules are right and nothing
 * about whether the hook actually applies them.
 *
 * 🔴 REACHABILITY IS ASSERTED, NOT ASSUMED. This codebase has shipped a stated
 * cap that provably could never fire because an earlier check always won. Every
 * bound below is proven binding by walking the state that reaches it.
 */

describe('decideRefreshRetry — the bounded automatic re-mint', () => {
  test('every attempt up to the cap is REACHABLE and schedules a retry', () => {
    // Walk the real sequence: 0 attempts spent → 1 → 2 → … Each step must be
    // reachable, i.e. actually return `retry`, or the cap below is dead code.
    const reached: number[] = [];
    for (let attempts = 0; attempts < MAX_REFRESH_RETRIES; attempts++) {
      const d = decideRefreshRetry({ attempts });
      expect(d.kind).toBe('retry');
      if (d.kind !== 'retry') throw new Error('unreachable');
      expect(d.attempt).toBe(attempts + 1);
      reached.push(d.attempt);
    }
    // Not a tautology: proves the loop really produced every attempt number and
    // that MAX_REFRESH_RETRIES > 0 (a 0 cap would make the whole feature inert).
    expect(reached).toEqual([1, 2, 3]);
    expect(MAX_REFRESH_RETRIES).toBeGreaterThan(0);
  });

  test('the cap BINDS: the attempt after the budget settles', () => {
    expect(decideRefreshRetry({ attempts: MAX_REFRESH_RETRIES })).toEqual({ kind: 'settled' });
    expect(decideRefreshRetry({ attempts: MAX_REFRESH_RETRIES + 5 })).toEqual({ kind: 'settled' });
  });

  test('backoff is escalating and covers exactly the attempt budget', () => {
    // 🔴 Pins the two constants to each other. If MAX_REFRESH_RETRIES is raised
    // without extending the table, the extra attempts silently reuse the last
    // delay — survivable, but not what the comment promises.
    expect(REFRESH_RETRY_BACKOFF_MS).toHaveLength(MAX_REFRESH_RETRIES);
    for (let i = 1; i < REFRESH_RETRY_BACKOFF_MS.length; i++) {
      expect(REFRESH_RETRY_BACKOFF_MS[i]).toBeGreaterThan(REFRESH_RETRY_BACKOFF_MS[i - 1]);
    }
    for (let attempts = 0; attempts < MAX_REFRESH_RETRIES; attempts++) {
      const d = decideRefreshRetry({ attempts });
      if (d.kind !== 'retry') throw new Error('unreachable');
      expect(d.delayMs).toBe(REFRESH_RETRY_BACKOFF_MS[attempts]);
    }
  });

  test('🔴 the WHOLE budget stays far under the endpoint rate limit', () => {
    // /api/v1/block-tokens allows 60/min per (user, instance). The worst case —
    // every automatic attempt failing — must not be able to approach that.
    const totalWindowMs = REFRESH_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(MAX_REFRESH_RETRIES).toBeLessThanOrEqual(5);
    expect(totalWindowMs).toBeGreaterThanOrEqual(30_000);
    // Requests per minute implied by the automatic loop, generously rounded up.
    const perMinute = (MAX_REFRESH_RETRIES / totalWindowMs) * 60_000;
    expect(perMinute).toBeLessThan(10);
  });

  test('a garbage attempt count cannot widen the budget', () => {
    expect(decideRefreshRetry({ attempts: -3 }).kind).toBe('retry');
    expect(decideRefreshRetry({ attempts: 2.9 })).toEqual(decideRefreshRetry({ attempts: 2 }));
  });
});

describe('shouldRetainTokenOnFailure — keeping the block alive through a blip', () => {
  const now = 1_700_000_000_000;
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  test('retains a token that is still live (the T-2min refresh-failure case)', () => {
    // The real shape: refresh fires 2 minutes before expiry and fails.
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: iso(2 * 60_000), now })).toBe(
      true
    );
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: iso(1), now })).toBe(true);
  });

  test('drops an expired token — never serve a dead credential', () => {
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: iso(0), now })).toBe(false);
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: iso(-1), now })).toBe(false);
  });

  test('🔴 FAILS CLOSED on an absent or unparseable expiry', () => {
    // We cannot prove the token is live → drop it, rather than hand the block a
    // credential of unknown validity that would silently 401.
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: null, now })).toBe(false);
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: 'not-a-date', now })).toBe(false);
    expect(shouldRetainTokenOnFailure({ token: 'tok', expiresAt: '', now })).toBe(false);
  });

  test('nothing to retain when there is no token (the initial-load failure)', () => {
    expect(shouldRetainTokenOnFailure({ token: null, expiresAt: iso(60_000), now })).toBe(false);
  });
});

describe('msUntilExpiry — the settled-token sweep deadline', () => {
  const now = 1_700_000_000_000;

  test('returns the remaining lifetime, floored at 0', () => {
    expect(msUntilExpiry(new Date(now + 5_000).toISOString(), now)).toBe(5_000);
    expect(msUntilExpiry(new Date(now - 5_000).toISOString(), now)).toBe(0);
  });

  test('returns null when there is no usable expiry to sweep at', () => {
    expect(msUntilExpiry(null, now)).toBeNull();
    expect(msUntilExpiry('nonsense', now)).toBeNull();
  });
});

describe('🔴 terminal mint refusals — never retry, never keep serving the token', () => {
  const now = 1_700_000_000_000;
  const live = { token: 'tok', expiresAt: new Date(now + 5 * 60_000).toISOString(), now };

  test('a terminal status settles immediately, spending NO retries', () => {
    for (const status of TERMINAL_MINT_STATUSES) {
      expect(decideRefreshRetry({ attempts: 0, mintStatus: status })).toEqual({ kind: 'settled' });
    }
  });

  test('🔴 a terminal status REFUSES to retain an otherwise-live token', () => {
    // Without this the block would keep a signature-valid, unexpired credential
    // for the rest of its lifetime after a ban / mod-delist / scope revocation —
    // an authorization extension introduced by a resilience feature. The mint's
    // 4xx IS the revocation signal for those (the runtime middleware only
    // re-checks uninstall/disable).
    for (const status of TERMINAL_MINT_STATUSES) {
      expect(shouldRetainTokenOnFailure({ ...live, mintStatus: status })).toBe(false);
    }
    // Control: the same token IS retained on a transient failure.
    expect(shouldRetainTokenOnFailure(live)).toBe(true);
  });

  test('TRANSIENT failures keep the full retry + retention behaviour', () => {
    // 5xx, 429 (has its own jittered in-band pause), and network/abort
    // (status undefined) must all stay retryable and retainable.
    for (const status of [undefined, 429, 500, 502, 503, 504]) {
      expect(decideRefreshRetry({ attempts: 0, mintStatus: status }).kind).toBe('retry');
      expect(shouldRetainTokenOnFailure({ ...live, mintStatus: status })).toBe(true);
    }
  });

  test('429 is deliberately NOT terminal', () => {
    // It is the one 4xx that explicitly means "try again later", and fetchOnce
    // already honours it with a jittered ~60s in-band pause.
    expect(isTerminalMintStatus(429)).toBe(false);
    expect(TERMINAL_MINT_STATUSES).not.toContain(429);
  });

  test('isTerminalMintStatus is closed over the enumerated set', () => {
    expect(isTerminalMintStatus(undefined)).toBe(false);
    for (const s of [200, 418, 500, 502, 503]) expect(isTerminalMintStatus(s)).toBe(false);
    for (const s of TERMINAL_MINT_STATUSES) expect(isTerminalMintStatus(s)).toBe(true);
  });
});

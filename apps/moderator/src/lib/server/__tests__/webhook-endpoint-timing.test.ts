import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE NO-EARLY-EXIT PROPERTY, pinned by counting the REAL comparisons the shipped loop performs.
 *
 * `authenticateWebhookToken` compares the presented token against every configured credential and
 * never stops at the first match, so how long the loop runs does not reveal WHICH credential matched.
 * That is a claim about the loop's control flow, and control flow is not observable from the return
 * value — the verdict is identical with and without a `break`.
 *
 * So the observation is the number of `timingSafeEqual` calls one request produces. It is taken from
 * the real `node:crypto` binding the module under test imports, not from a re-implementation: a model
 * of the loop written in the test file would go on passing after a `break` was added to production.
 *
 * Two classes are accepted everywhere (MOD_INBOUND_TOKEN and the scoped MOD_CASES_TOKEN), so the
 * property is observable: a loop that stopped at the first match would compare once when the FIRST class
 * matches and twice otherwise. The 'no early exit' block below is the case that tells the two loops apart;
 * its two controls only mean something beside it. On the tag write-back path KNIGHTS_TAG_REVIEW_TOKEN is a
 * third candidate (and is none elsewhere), which the scoped-path block pins the same way.
 *
 * 🔴 EVERY FIXTURE SECRET BELOW IS THE SAME LENGTH. The loop checks length before calling
 * timingSafeEqual (that function throws on a length mismatch), so a shorter second secret would be
 * skipped by the length check and never counted — a count would then read low and blame a `break`
 * that is not there. Equal lengths are what make the count a measurement of the loop rather than of
 * the fixture. Keep that true of any secret added here.
 *
 * This file mocks a module at load, so it is deliberately separate from `webhook-endpoint.test.ts`
 * rather than being a `describe` block with a local reset: a module mock is file-scoped, and reaching
 * for `vi.resetModules()` to confine one has already produced an order-dependent verdict in this
 * codebase.
 */

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  // Spread the real module and wrap ONE export. A hand-written replacement object goes stale the
  // moment the module under test reaches for a second crypto function, and does so as an import-time
  // failure that reads like a broken suite rather than a stale mock.
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

const { authenticateWebhookToken } = await import('$lib/server/webhook-endpoint');

/** Same LENGTH, different bytes — see the header. */
const INBOUND_SECRET = 'inbound-secret-value-aaaa';
const LEGACY_SECRET = 'legacy--secret-value-bbbb';
const CASES_SECRET = 'cases---secret-value-dddd';
const KNIGHTS_SECRET = 'knights-secret-value-eeee';
const SCOPED_PATH = '/api/mod/image-tag-moderate';

function requestPresenting(token: string, path = '/api/mod/abuse-report') {
  const url = new URL(`https://moderator.civitai.com${path}`);
  url.searchParams.set('token', token);
  return { url, request: new Request(url, { method: 'POST' }) };
}

function setEnv(vars: {
  WEBHOOK_TOKEN?: string;
  MOD_INBOUND_TOKEN?: string;
  MOD_CASES_TOKEN?: string;
  KNIGHTS_TAG_REVIEW_TOKEN?: string;
}) {
  for (const k of [
    'WEBHOOK_TOKEN',
    'MOD_INBOUND_TOKEN',
    'MOD_CASES_TOKEN',
    'KNIGHTS_TAG_REVIEW_TOKEN',
  ] as const) {
    delete process.env[k];
    if (vars[k] !== undefined) process.env[k] = vars[k];
  }
}

const saved = {
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN,
  MOD_INBOUND_TOKEN: process.env.MOD_INBOUND_TOKEN,
  MOD_CASES_TOKEN: process.env.MOD_CASES_TOKEN,
  KNIGHTS_TAG_REVIEW_TOKEN: process.env.KNIGHTS_TAG_REVIEW_TOKEN,
};

/**
 * Every test owns its own reset, so no verdict here depends on the order the file runs in.
 *
 * LEGACY_SECRET is still injected even though it is no longer an accepted class — that is exactly
 * what the removal regression below measures. A deployment that still sets the variable (and every
 * one of them does, because four outbound callers need it) must not gain a second candidate.
 */
beforeEach(() => {
  timingSafeEqualSpy.mockClear();
  setEnv({
    MOD_INBOUND_TOKEN: INBOUND_SECRET,
    WEBHOOK_TOKEN: LEGACY_SECRET,
    KNIGHTS_TAG_REVIEW_TOKEN: KNIGHTS_SECRET,
  });
});
afterEach(() => setEnv(saved));

describe('the token comparison loop', () => {
  it('POSITIVE CONTROL: the counter tracks candidates — one configured credential produces one comparison', () => {
    // Without this, any count below would be indistinguishable from a spy that fires on something
    // other than the loop. Establish that the number tracks configured credentials before reading any
    // other count in this file as evidence.
    setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET });
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: WEBHOOK_TOKEN set in the environment is NOT a candidate — the removal took effect at RUNTIME', () => {
    // The guard for dropping the legacy class. `beforeEach` sets BOTH variables, which is the real
    // deployment shape, so a removal that only edited the array while `acceptedTokens()` went on
    // reading the variable would produce TWO comparisons here. One is the assertion that the class is
    // genuinely gone from the accepted set rather than merely absent from a list.
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: the legacy secret is now REFUSED, not merely unattributed', () => {
    // Presenting the retired credential must fail closed. Asserted on the verdict rather than the
    // count, because a count alone cannot tell "compared and rejected" from "never a candidate".
    const result = authenticateWebhookToken(requestPresenting(LEGACY_SECRET));
    expect(result.kind).toBe('refused');
  });

  it('CONTROL: no match still compares every candidate', () => {
    const result = authenticateWebhookToken(requestPresenting('wrong-secret-value-cccccc'));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('INVARIANT: a length mismatch is never handed to timingSafeEqual, which throws on one', () => {
    // The length guard is what keeps a short token a 401 rather than a 500 out of the hook. The
    // configured secret is longer than this, so a comparison count of 0 asserts the guard ran ahead
    // of the call.
    const result = authenticateWebhookToken(requestPresenting('short'));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(0);
  });
});

describe('no early exit, with both classes configured', () => {
  beforeEach(() => setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET, MOD_CASES_TOKEN: CASES_SECRET }));

  it('a match on the FIRST candidate STILL compares the second', () => {
    // The discriminating case: a loop with a `break` answers 1 here and 2 in both controls below.
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a match on the LAST candidate compares both', () => {
    const result = authenticateWebhookToken(requestPresenting(CASES_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_CASES_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: no match compares both', () => {
    const result = authenticateWebhookToken(requestPresenting('wrong-secret-value-cccccc'));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('a value shared by both variables resolves to the narrower scoped class', () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET, MOD_CASES_TOKEN: INBOUND_SECRET });
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_CASES_TOKEN' });
  });
});

describe('the token comparison loop on the tag write-back path (three candidates)', () => {
  beforeEach(() =>
    setEnv({
      MOD_INBOUND_TOKEN: INBOUND_SECRET,
      MOD_CASES_TOKEN: CASES_SECRET,
      KNIGHTS_TAG_REVIEW_TOKEN: KNIGHTS_SECRET,
    })
  );

  it('a match on the FIRST candidate STILL compares the other two', () => {
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET, SCOPED_PATH));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(3);
  });

  it('CONTROL: a match on the LAST candidate compares all three', () => {
    const result = authenticateWebhookToken(requestPresenting(KNIGHTS_SECRET, SCOPED_PATH));
    expect(result).toEqual({ kind: 'authenticated', credential: 'KNIGHTS_TAG_REVIEW_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(3);
  });

  it('CONTROL: no match compares all three', () => {
    const result = authenticateWebhookToken(
      requestPresenting('wrong-secret-value-cccccc', SCOPED_PATH)
    );
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(3);
  });

  it('off the scoped path the scoped secret is not a candidate', () => {
    const result = authenticateWebhookToken(requestPresenting(KNIGHTS_SECRET));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });
});

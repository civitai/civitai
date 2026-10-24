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
 * 🔴 THE DISCRIMINATING CASE IS DORMANT, AND THIS FILE IS KEPT FOR THE DAY IT IS NOT.
 * `ACCEPTED_CREDENTIALS` has ONE entry since the legacy class was dropped, and at length 1 the
 * property is STRUCTURALLY UNOBSERVABLE: a loop with a `break` and a loop without both perform exactly
 * one comparison, so no assertion written here can tell them apart. That is not the same as the
 * property being unnecessary — the loop is still in production and still has no `break`, and the
 * moment a second class is added (scoped tokens; see the module header) the leak it prevents is real
 * again. The three cases that USED to discriminate are recorded in `DORMANT` below rather than
 * deleted, because a guard nobody knows existed does not get rebuilt.
 *
 * 🔴 SO DO NOT READ THIS FILE'S GREEN AS COVERAGE OF THE NO-EARLY-EXIT PROPERTY. What still executes
 * is real and worth having — ALL FIVE live tests: the counter's own positive control, the
 * length-mismatch invariant, the no-match control, and two REGRESSION cases pinning that the retired
 * class is neither a candidate nor authenticatable (both go red if it is restored to the accepted
 * set) — but NONE of them is a test of control flow.
 *
 * 🔴 EVERY FIXTURE SECRET BELOW IS THE SAME LENGTH. The loop checks length before calling
 * timingSafeEqual (that function throws on a length mismatch), so a shorter second secret would be
 * skipped by the length check and never counted — a count would then read low and blame a `break`
 * that is not there. Equal lengths are what make the count a measurement of the loop rather than of
 * the fixture. Keep that true of any secret added when this file is re-armed.
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

function requestPresenting(token: string) {
  const url = new URL('https://moderator.civitai.com/api/mod/abuse-report');
  url.searchParams.set('token', token);
  return { url, request: new Request(url, { method: 'POST' }) };
}

function setEnv(vars: { WEBHOOK_TOKEN?: string; MOD_INBOUND_TOKEN?: string }) {
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.MOD_INBOUND_TOKEN;
  if (vars.WEBHOOK_TOKEN !== undefined) process.env.WEBHOOK_TOKEN = vars.WEBHOOK_TOKEN;
  if (vars.MOD_INBOUND_TOKEN !== undefined) process.env.MOD_INBOUND_TOKEN = vars.MOD_INBOUND_TOKEN;
}

const saved = {
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN,
  MOD_INBOUND_TOKEN: process.env.MOD_INBOUND_TOKEN,
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
  setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET, WEBHOOK_TOKEN: LEGACY_SECRET });
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

/*
 * DORMANT — the three cases that discriminated a `break` from no `break`. They are recorded rather
 * than deleted because at ONE accepted credential they cannot be written truthfully (see the header),
 * and a guard nobody knows existed does not get rebuilt. They are NOT expressed as skipped tests on
 * purpose: a `describe.skip` reports green-ish and reads as coverage, which is the thing this block
 * exists to avoid claiming.
 *
 * TO RE-ARM, when ACCEPTED_CREDENTIALS gains a second entry: set both variables to same-LENGTH,
 * different-byte secrets (the header explains why equal length is load-bearing) and restore
 *
 *   'a match on the FIRST candidate STILL compares the second — no early exit'
 *     → authenticate with the FIRST secret; expect 2 comparisons.
 *       This is the only case that discriminates: an early exit answers 1 here and 2 in both
 *       controls below, so the other two are worthless without it.
 *
 *   'a match on the LAST candidate compares both — an early-exit loop answers 2 here too'
 *     → authenticate with the SECOND secret; expect 2 comparisons.
 *
 *   'no match compares both — an early-exit loop answers 2 here too'
 *     → present a wrong secret of equal length; expect 2 comparisons.
 *
 * The production invariant they pin is in `webhook-endpoint.ts`: the match loop records which
 * candidate matched with a single assignment, NO `break` and NO `else`.
 */

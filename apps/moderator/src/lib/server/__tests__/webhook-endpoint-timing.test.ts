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
 * 🔴 EVERY FIXTURE SECRET BELOW IS THE SAME LENGTH. The loop checks length before calling
 * timingSafeEqual (that function throws on a length mismatch), so a shorter second secret would be
 * skipped by the length check and never counted — the test would then read 1 comparison and blame a
 * `break` that is not there. Equal lengths are what make the count a measurement of the loop rather
 * than of the fixture.
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

/** Every test owns its own reset, so no verdict here depends on the order the file runs in. */
beforeEach(() => {
  timingSafeEqualSpy.mockClear();
  setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET, WEBHOOK_TOKEN: LEGACY_SECRET });
});
afterEach(() => setEnv(saved));

describe('the token comparison loop', () => {
  it('POSITIVE CONTROL: the counter tracks candidates — one configured credential produces one comparison', () => {
    // Without this, a `2` below would be indistinguishable from a spy that fires on something other
    // than the loop. Watch the number MOVE with the number of configured credentials before reading
    // any other count in this file as evidence about control flow.
    setEnv({ MOD_INBOUND_TOKEN: INBOUND_SECRET });
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a match on the FIRST candidate STILL compares the second — no early exit', () => {
    // The one observation that discriminates. An early exit answers 1 here and 2 in both controls
    // below, so this case alone is what separates the two implementations.
    const result = authenticateWebhookToken(requestPresenting(INBOUND_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a match on the LAST candidate compares both — an early-exit loop answers 2 here too', () => {
    const result = authenticateWebhookToken(requestPresenting(LEGACY_SECRET));
    expect(result).toEqual({ kind: 'authenticated', credential: 'WEBHOOK_TOKEN' });
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: no match compares both — an early-exit loop answers 2 here too', () => {
    const result = authenticateWebhookToken(requestPresenting('wrong-secret-value-cccccc'));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(2);
  });

  it('INVARIANT: a length mismatch is never handed to timingSafeEqual, which throws on one', () => {
    // The length guard is what keeps a short token a 401 rather than a 500 out of the hook. Both
    // configured secrets are longer than this, so a comparison count of 0 is the assertion that the
    // guard ran ahead of the call for BOTH candidates.
    const result = authenticateWebhookToken(requestPresenting('short'));
    expect(result.kind).toBe('refused');
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(0);
  });
});

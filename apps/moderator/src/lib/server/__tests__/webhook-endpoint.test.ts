import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ACCEPTED_CREDENTIALS,
  authenticateWebhookToken,
  type WebhookAuthResult,
} from '$lib/server/webhook-endpoint';

/**
 * Inbound service-token authentication — the ONLY place this app verifies a token. `WebhookEndpoint`
 * and `defineWebhookEndpoint` only assert the verdict this function produced (`locals.tokenClient`),
 * so everything about which credentials are accepted is decided here.
 *
 * Two tiers below, labelled, because they are not the same kind of evidence. The tiers are defined by
 * the MATRIX, not by subject matter — run this file against a tree without the credential-attribution
 * change and exactly the REGRESSION set fails:
 *
 *   REGRESSION — red before the change, green after: the cases that pin WHICH credential matched, and
 *     the tagged-union verdict shape that carries it.
 *   INVARIANT  — green on BOTH sides once the union shape is accounted for: the accept/refuse/503
 *     decisions themselves, which this change must not move. They are here because the change's whole
 *     point is that they must KEEP passing — the main app presents WEBHOOK_TOKEN on every call into
 *     this app, so recording which credential matched must not stop either one from matching.
 *
 * `$env/dynamic/private` is aliased to `src/test/env.mock.ts`, which is `process.env` itself, and
 * `acceptedTokens()` re-reads it per call — so assigning here really does change what the function
 * sees.
 *
 * 🔴 The two secret VALUES are deliberately unrelated to the two credential CLASS names an assertion
 * checks for. A fixture whose value equals the constant the assertion names cannot see a mutant that
 * hardcodes that constant.
 */

const LEGACY = 'legacy-shared-token';
const INBOUND = 'inbound-only-token';

function eventWith(presented: { query?: string; authorization?: string }) {
  const url = new URL('https://moderator.civitai.com/api/mod/abuse-report');
  if (presented.query !== undefined) url.searchParams.set('token', presented.query);
  const headers = new Headers();
  if (presented.authorization !== undefined) headers.set('authorization', presented.authorization);
  return { url, request: new Request(url, { method: 'POST', headers }) };
}

/** Both variables are deleted rather than blanked — blank is a case under test in its own right. */
function setEnv(vars: { WEBHOOK_TOKEN?: string; MOD_INBOUND_TOKEN?: string }) {
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.MOD_INBOUND_TOKEN;
  if (vars.WEBHOOK_TOKEN !== undefined) process.env.WEBHOOK_TOKEN = vars.WEBHOOK_TOKEN;
  if (vars.MOD_INBOUND_TOKEN !== undefined) process.env.MOD_INBOUND_TOKEN = vars.MOD_INBOUND_TOKEN;
}

/**
 * Narrows to the refused arm, failing the test rather than throwing an unhelpful cast error when the
 * verdict is something else. Asserting `kind` here is what makes the `.status` read below meaningful:
 * a bare cast would read `undefined` off an authenticated verdict and compare it to a number.
 */
function refusalOf(result: WebhookAuthResult): Response {
  expect(result.kind).toBe('refused');
  if (result.kind !== 'refused') throw new Error('not a refusal');
  return result.response;
}

const saved = {
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN,
  MOD_INBOUND_TOKEN: process.env.MOD_INBOUND_TOKEN,
};

beforeEach(() => setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: INBOUND }));
afterEach(() => setEnv(saved));

describe('authenticateWebhookToken', () => {
  it('INVARIANT: returns kind "none" when no credential is presented, so the session guard runs', () => {
    expect(authenticateWebhookToken(eventWith({}))).toEqual({ kind: 'none' });
  });

  it('REGRESSION: attributes WEBHOOK_TOKEN via ?token= — the main app calls in this way', () => {
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('REGRESSION: attributes WEBHOOK_TOKEN via Authorization: Bearer', () => {
    expect(authenticateWebhookToken(eventWith({ authorization: `Bearer ${LEGACY}` }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('REGRESSION: attributes MOD_INBOUND_TOKEN via ?token=', () => {
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toEqual({
      kind: 'authenticated',
      credential: 'MOD_INBOUND_TOKEN',
    });
  });

  it('REGRESSION: attributes MOD_INBOUND_TOKEN via Authorization: Bearer', () => {
    expect(authenticateWebhookToken(eventWith({ authorization: `Bearer ${INBOUND}` }))).toEqual({
      kind: 'authenticated',
      credential: 'MOD_INBOUND_TOKEN',
    });
  });

  it('REGRESSION: the two classes are attributed DIFFERENTLY from the same deployment', () => {
    // The pairwise-distinct check the whole signal rests on: a stub returning one constant for every
    // caller satisfies either test above on its own, and fails this one. Both verdicts are read from
    // the SAME env state, so nothing but the presented bytes can be deciding.
    const legacy = authenticateWebhookToken(eventWith({ query: LEGACY }));
    const inbound = authenticateWebhookToken(eventWith({ query: INBOUND }));
    expect(legacy).toEqual({ kind: 'authenticated', credential: 'WEBHOOK_TOKEN' });
    expect(inbound).toEqual({ kind: 'authenticated', credential: 'MOD_INBOUND_TOKEN' });
  });

  it('REGRESSION: MOD_INBOUND_TOKEN alone is a complete configuration — the post-migration state', () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND });
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toEqual({
      kind: 'authenticated',
      credential: 'MOD_INBOUND_TOKEN',
    });
  });

  it('REGRESSION: WEBHOOK_TOKEN alone is a complete configuration — the pre-migration state', () => {
    setEnv({ WEBHOOK_TOKEN: LEGACY });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('INVARIANT: the two tokens are independent — presenting one does not depend on the other being set', () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND });
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: LEGACY }))).status).toBe(401);
  });

  it('INVARIANT: refuses an unrecognised token with 401', () => {
    expect(
      refusalOf(authenticateWebhookToken(eventWith({ query: 'not-either-of-them' }))).status
    ).toBe(401);
  });

  it('INVARIANT: refuses a token that is a PREFIX of an accepted one', () => {
    expect(
      refusalOf(authenticateWebhookToken(eventWith({ query: INBOUND.slice(0, -1) }))).status
    ).toBe(401);
  });

  it('INVARIANT: refuses a token that is a SUPERSTRING of an accepted one', () => {
    // The mirror of the prefix case, and the one that exercises the length check as an EQUALITY
    // rather than a floor: relaxing `===` to `>=` makes timingSafeEqual throw on this input, which
    // is a 500 out of the hook instead of a 401.
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: `${INBOUND}x` }))).status).toBe(
      401
    );
  });

  it('REGRESSION: both variables set to the SAME value attribute to the LEGACY class, not the preferred one', () => {
    // 🔴 The ambiguous case, and the direction of the bias is the point. One shared value is
    // indistinguishable on the wire, so attribution has to pick; picking the most legacy class can
    // only OVERSTATE legacy use, and a migration proof that errs toward "still in use" is safe while
    // one that errs toward zero authorises the removal that 401s every delegated moderation action.
    //
    // This also pins the no-`else`/last-match-wins shape of the match loop against the tidier-looking
    // first-match-wins rewrite, which would report the post-migration class here.
    setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: LEGACY });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('REGRESSION: EVERY accepted class is reachable — no class can be listed but never attributable', () => {
    // The ledger guard. A class added to ACCEPTED_CREDENTIALS but not read in `acceptedTokens` would
    // be accepted-in-name-only: never matching, and therefore invisible in the attribution counts
    // that the WEBHOOK_TOKEN removal is graded on. Driving each class from the list itself means the
    // set cannot GROW past what is exercised here.
    const distinct = Object.fromEntries(
      ACCEPTED_CREDENTIALS.map((credential, i) => [credential, `secret-number-${i}`])
    );
    for (const credential of ACCEPTED_CREDENTIALS) {
      setEnv(distinct);
      expect(authenticateWebhookToken(eventWith({ query: distinct[credential] }))).toEqual({
        kind: 'authenticated',
        credential,
      });
    }
  });

  it('INVARIANT: a WHITESPACE-ONLY secret is not configured — this closed a real bypass', () => {
    // 🔴 The case that made the `.filter()` load-bearing rather than tidy. Before it the guard was
    // `if (!expected)`, which a whitespace-only value passes as truthy; the secret was then
    // `.trim()`ed to ZERO length, and timingSafeEqual(<empty>, <empty>) is TRUE — so a request
    // presenting `?token=` with no value authenticated and every wrapped endpoint was open. Latent (a
    // real deployment holds a real value) but real, and pinned here so it stays shut.
    setEnv({ WEBHOOK_TOKEN: '   ' });
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: '' }))).status).toBe(503);
  });

  it('INVARIANT: fails CLOSED with 503 when neither variable is configured', () => {
    setEnv({});
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: LEGACY }))).status).toBe(503);
  });

  it('INVARIANT: the 503 names EVERY accepted class, so an operator knows any one would fix it', async () => {
    setEnv({});
    const body = await refusalOf(authenticateWebhookToken(eventWith({ query: LEGACY }))).json();
    // The whole normalised sentence, not a substring: a body that names only one class still contains
    // that class's name, so a `stringContaining` guard passes on exactly the message that would send
    // an operator to set the wrong variable.
    expect(body).toEqual({
      message: 'Neither MOD_INBOUND_TOKEN nor WEBHOOK_TOKEN is configured on this deployment.',
    });
  });

  it('INVARIANT: a variable set to empty is NOT configured — an empty presented token is refused', () => {
    // The dangerous shape: blanking the secret must not make every wrapped endpoint open. With both
    // blank there is nothing to accept, so this is the 503 fail-closed path, NOT a match.
    setEnv({ WEBHOOK_TOKEN: '', MOD_INBOUND_TOKEN: '' });
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: '' }))).status).toBe(503);
  });

  it('INVARIANT: a blank MOD_INBOUND_TOKEN does not become a usable credential alongside a real one', () => {
    setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: '' });
    expect(refusalOf(authenticateWebhookToken(eventWith({ query: '' }))).status).toBe(401);
    // …and the real one still works, still attributed to the class it came from.
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('REGRESSION: a WEBHOOK_TOKEN injected with surrounding whitespace still matches, and is still attributed', () => {
    setEnv({ WEBHOOK_TOKEN: `  ${LEGACY}\n` });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toEqual({
      kind: 'authenticated',
      credential: 'WEBHOOK_TOKEN',
    });
  });

  it('REGRESSION: the same whitespace tolerance applies to MOD_INBOUND_TOKEN', () => {
    setEnv({ MOD_INBOUND_TOKEN: `  ${INBOUND}\n` });
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toEqual({
      kind: 'authenticated',
      credential: 'MOD_INBOUND_TOKEN',
    });
  });

  it('INVARIANT: a non-Bearer Authorization scheme is refused rather than treated as a token', () => {
    expect(
      refusalOf(authenticateWebhookToken(eventWith({ authorization: `Basic ${INBOUND}` }))).status
    ).toBe(401);
  });
});

// The no-early-exit property of the comparison loop is pinned in `webhook-endpoint-timing.test.ts`,
// which needs a module-level mock of `node:crypto` and therefore its own file.

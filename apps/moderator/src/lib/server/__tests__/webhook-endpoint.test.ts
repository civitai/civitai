import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authenticateWebhookToken } from '$lib/server/webhook-endpoint';

/**
 * Inbound service-token authentication — the ONLY place this app verifies a token. `WebhookEndpoint`
 * and `defineWebhookEndpoint` only assert the verdict this function produced (`locals.tokenClient`),
 * so everything about which credentials are accepted is decided here.
 *
 * Two tiers below, labelled, because they are not the same kind of evidence:
 *
 *   REGRESSION — the MOD_INBOUND_TOKEN cases. Red before the change (the function read only
 *     `env.WEBHOOK_TOKEN`), green after.
 *   INVARIANT  — the WEBHOOK_TOKEN, fail-closed and rejection cases. These passed before the change
 *     too. They are here because the change's whole point is that they must KEEP passing: the main
 *     app presents WEBHOOK_TOKEN on every call into this app, so accepting a second token must not
 *     stop accepting the first.
 *
 * `$env/dynamic/private` is aliased to `src/test/env.mock.ts`, which is `process.env` itself, and
 * `acceptedTokens()` re-reads it per call — so assigning here really does change what the function
 * sees.
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

const saved = {
  WEBHOOK_TOKEN: process.env.WEBHOOK_TOKEN,
  MOD_INBOUND_TOKEN: process.env.MOD_INBOUND_TOKEN,
};

beforeEach(() => setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: INBOUND }));
afterEach(() => setEnv(saved));

describe('authenticateWebhookToken', () => {
  it('INVARIANT: returns "none" when no credential is presented, so the session guard runs', () => {
    expect(authenticateWebhookToken(eventWith({}))).toBe('none');
  });

  it('INVARIANT: accepts WEBHOOK_TOKEN via ?token= — the main app calls in this way', () => {
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toBe('webhook');
  });

  it('INVARIANT: accepts WEBHOOK_TOKEN via Authorization: Bearer', () => {
    expect(authenticateWebhookToken(eventWith({ authorization: `Bearer ${LEGACY}` }))).toBe(
      'webhook'
    );
  });

  it('REGRESSION: accepts MOD_INBOUND_TOKEN via ?token=', () => {
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toBe('webhook');
  });

  it('REGRESSION: accepts MOD_INBOUND_TOKEN via Authorization: Bearer', () => {
    expect(authenticateWebhookToken(eventWith({ authorization: `Bearer ${INBOUND}` }))).toBe(
      'webhook'
    );
  });

  it('REGRESSION: MOD_INBOUND_TOKEN alone is a complete configuration — the post-migration state', () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND });
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toBe('webhook');
  });

  it('INVARIANT: WEBHOOK_TOKEN alone is a complete configuration — the pre-migration state', () => {
    setEnv({ WEBHOOK_TOKEN: LEGACY });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toBe('webhook');
  });

  it('REGRESSION: the two tokens are independent — presenting one does not depend on the other being set', async () => {
    setEnv({ MOD_INBOUND_TOKEN: INBOUND });
    const refused = authenticateWebhookToken(eventWith({ query: LEGACY }));
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(401);
  });

  it('INVARIANT: refuses an unrecognised token with 401', async () => {
    const result = authenticateWebhookToken(eventWith({ query: 'not-either-of-them' }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('INVARIANT: refuses a token that is a PREFIX of an accepted one', async () => {
    const result = authenticateWebhookToken(eventWith({ query: INBOUND.slice(0, -1) }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('INVARIANT: refuses a token that is a SUPERSTRING of an accepted one', async () => {
    // The mirror of the prefix case, and the one that exercises the length check as an EQUALITY
    // rather than a floor: relaxing `===` to `>=` makes timingSafeEqual throw on this input, which
    // is a 500 out of the hook instead of a 401.
    const result = authenticateWebhookToken(eventWith({ query: `${INBOUND}x` }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('INVARIANT: both variables set to the SAME value still authenticates exactly once', () => {
    setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: LEGACY });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toBe('webhook');
  });

  it('REGRESSION: a WHITESPACE-ONLY secret is not configured — this closed a real bypass', async () => {
    // 🔴 The case that made the `.filter()` load-bearing rather than tidy. Before this change the
    // guard was `if (!expected)`, which a whitespace-only value passes as truthy; the secret was then
    // `.trim()`ed to ZERO length, and timingSafeEqual(<empty>, <empty>) is TRUE — so a request
    // presenting `?token=` with no value authenticated as 'webhook' and every wrapped endpoint was
    // open. Latent (a real deployment holds a real value) but real, and pinned here so it stays shut.
    setEnv({ WEBHOOK_TOKEN: '   ' });
    const result = authenticateWebhookToken(eventWith({ query: '' }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });

  it('INVARIANT: fails CLOSED with 503 when neither variable is configured', async () => {
    setEnv({});
    const result = authenticateWebhookToken(eventWith({ query: LEGACY }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });

  it('REGRESSION: the 503 names BOTH variables, so an operator knows either would fix it', async () => {
    setEnv({});
    const result = authenticateWebhookToken(eventWith({ query: LEGACY })) as Response;
    await expect(result.json()).resolves.toMatchObject({
      message: expect.stringContaining('MOD_INBOUND_TOKEN'),
    });
  });

  it('INVARIANT: a variable set to empty is NOT configured — an empty presented token is refused', async () => {
    // The dangerous shape: blanking the secret must not make every wrapped endpoint open. With both
    // blank there is nothing to accept, so this is the 503 fail-closed path, NOT a match.
    setEnv({ WEBHOOK_TOKEN: '', MOD_INBOUND_TOKEN: '' });
    const result = authenticateWebhookToken(eventWith({ query: '' }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(503);
  });

  it('INVARIANT: a blank MOD_INBOUND_TOKEN does not become a usable credential alongside a real one', async () => {
    setEnv({ WEBHOOK_TOKEN: LEGACY, MOD_INBOUND_TOKEN: '' });
    const empty = authenticateWebhookToken(eventWith({ query: '' }));
    expect(empty).toBeInstanceOf(Response);
    expect((empty as Response).status).toBe(401);
    // …and the real one still works.
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toBe('webhook');
  });

  it('INVARIANT: a WEBHOOK_TOKEN injected with surrounding whitespace still matches what a caller sends', () => {
    setEnv({ WEBHOOK_TOKEN: `  ${LEGACY}\n` });
    expect(authenticateWebhookToken(eventWith({ query: LEGACY }))).toBe('webhook');
  });

  it('REGRESSION: the same whitespace tolerance applies to MOD_INBOUND_TOKEN', () => {
    setEnv({ MOD_INBOUND_TOKEN: `  ${INBOUND}\n` });
    expect(authenticateWebhookToken(eventWith({ query: INBOUND }))).toBe('webhook');
  });

  it('INVARIANT: a non-Bearer Authorization scheme is refused rather than treated as a token', async () => {
    const result = authenticateWebhookToken(eventWith({ authorization: `Basic ${INBOUND}` }));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

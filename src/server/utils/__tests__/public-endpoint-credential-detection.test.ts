import { describe, expect, it, vi } from 'vitest';

/**
 * Direct unit tests for the credential predicate `PublicEndpoint` branches on.
 *
 * The wrapper-level contract lives in `public-endpoint-credentialed-cache.test.ts`;
 * this file exercises the predicate in isolation so a mutation to it fails with
 * an assertion naming the predicate rather than a downstream header value.
 *
 * The predicate is deliberately header-only and PESSIMISTIC — it says "yes" for
 * a credential that would turn out to be expired or bogus. A false positive
 * costs one uncached response; a false negative marks a caller-specific body
 * publicly cacheable. The asymmetry is the whole design, so the cases below pin
 * BOTH directions: every credential spelling is recognised, and nothing else is.
 */

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
vi.mock('~/env/server', () => ({
  env: new Proxy(
    { TRPC_ORIGINS: [] as string[], NEXTAUTH_URL: undefined } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : undefined) }
  ),
}));
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn() }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/utils/key-generator', () => ({ generateSecretHash: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: vi.fn(() => false) }));

import { legacySessionCookieName, sessionCookieName } from '@civitai/auth';
import { requestCarriesCallerCredentials } from '../endpoint-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

const CREDENTIAL_COOKIES: [string, string][] = [
  ['current secure session cookie', sessionCookieName(true)],
  ['current dev session cookie', sessionCookieName(false)],
  ['legacy secure session cookie', legacySessionCookieName(true)],
  ['legacy dev session cookie', legacySessionCookieName(false)],
];

describe('requestCarriesCallerCredentials — recognises a credential', () => {
  it.each(CREDENTIAL_COOKIES)('is true for the %s in req.cookies', (_label, cookieName) => {
    expect(
      requestCarriesCallerCredentials({ headers: {}, cookies: { [cookieName]: 'abc' } } as never)
    ).toBe(true);
  });

  it.each(CREDENTIAL_COOKIES)('is true for the %s on the raw Cookie header', (_l, cookieName) => {
    expect(
      requestCarriesCallerCredentials({
        headers: { cookie: `ga_session=1; ${cookieName}=abc; other=2` },
      } as never)
    ).toBe(true);
  });

  it('is true for an Authorization header with no cookies at all', () => {
    expect(
      requestCarriesCallerCredentials({ headers: { authorization: 'Bearer abc' } } as never)
    ).toBe(true);
  });

  it('is true for a ?token= api key in req.query', () => {
    expect(
      requestCarriesCallerCredentials({
        headers: {},
        query: { token: 'abc' },
        url: '/api/v1/users?token=abc',
      } as never)
    ).toBe(true);
  });

  it('is true for a ?token= present only on req.url', () => {
    // `getServerAuthSession` reads `req.url` rather than Next's parsed `req.query`,
    // so a context that skips that parsing must not read as anonymous.
    expect(
      requestCarriesCallerCredentials({
        headers: {},
        url: '/api/v1/users?page=2&token=abc',
      } as never)
    ).toBe(true);
  });

  it('is true for a repeated ?token= arriving as an array', () => {
    expect(
      requestCarriesCallerCredentials({ headers: {}, query: { token: ['', 'abc'] } } as never)
    ).toBe(true);
  });

  it('tolerates a malformed cookie segment with no "=" alongside a real one', () => {
    expect(
      requestCarriesCallerCredentials({
        headers: { cookie: `broken; ${sessionCookieName(true)}=abc` },
      } as never)
    ).toBe(true);
  });
});

describe('requestCarriesCallerCredentials — does not over-match', () => {
  it('is false for a bare request', () => {
    expect(requestCarriesCallerCredentials({ headers: {} } as never)).toBe(false);
  });

  it('is false for unrelated cookies, including near-miss names', () => {
    const decoys = {
      ga_session: '1',
      theme: 'dark',
      'civ-token-decoy': 'x',
      'x-civ-token': 'y',
    };
    expect(
      requestCarriesCallerCredentials({
        headers: { cookie: 'ga_session=1; theme=dark; civ-token-decoy=x; x-civ-token=y' },
        cookies: decoys,
      } as never)
    ).toBe(false);
  });

  it('is false for an empty Authorization header', () => {
    expect(requestCarriesCallerCredentials({ headers: { authorization: '' } } as never)).toBe(
      false
    );
  });

  it('is false for an empty session cookie value', () => {
    expect(
      requestCarriesCallerCredentials({
        headers: {},
        cookies: { [sessionCookieName(true)]: '' },
      } as never)
    ).toBe(false);
  });

  it('is false for query parameters that merely look like a token', () => {
    // The discriminator must be the `token` parameter, not the presence of a
    // query string — otherwise every paged public request leaves the cached arm.
    expect(
      requestCarriesCallerCredentials({
        headers: {},
        query: { page: '2', tokenizer: 'x', access_token_hint: 'y' },
        url: '/api/v1/users?page=2&tokenizer=x&access_token_hint=y',
      } as never)
    ).toBe(false);
  });

  it('is false for an empty ?token= value', () => {
    expect(
      requestCarriesCallerCredentials({
        headers: {},
        query: { token: '' },
        url: '/api/v1/users?token=',
      } as never)
    ).toBe(false);
  });

  it('is false for a url with no query string at all', () => {
    expect(requestCarriesCallerCredentials({ headers: {}, url: '/api/v1/users' } as never)).toBe(
      false
    );
  });
});

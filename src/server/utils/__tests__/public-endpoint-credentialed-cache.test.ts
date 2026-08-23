import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `PublicEndpoint` stamps `Cache-Control: public, s-maxage=…` before the handler
 * runs. `public` is a claim that any caller may be served this exact body — but
 * several routes on this wrapper resolve the session themselves and shape their
 * response around it, so the claim only holds for a request that presented no
 * credential.
 *
 * This suite pins both halves of the resulting contract:
 *
 *   1. the anonymous arm is UNCHANGED — a change that stopped caching for
 *      everyone would be a regression, and the first tests are what prove it did
 *      not happen;
 *   2. a request carrying a session cookie or an `Authorization` header gets the
 *      platform's private default instead;
 *   3. every response declares `Vary: Cookie, Authorization`, on both arms;
 *   4. a handler's own `Cache-Control` still wins, so the `no-store` error arms
 *      stay authoritative.
 *
 * Every expected header value below is a LITERAL, never re-derived from the
 * implementation's own constants — so this file is meaningful run against code
 * that predates them.
 *
 * The cookie names ARE resolved through `@civitai/auth`, exactly as the
 * implementation resolves them, and then asserted against their literal
 * spellings — so a rename on either side is visible rather than silent.
 *
 * Exercises the REAL `PublicEndpoint` wrapper with only the heavy module-load
 * imports stubbed (mirrors public-endpoint-cache-override.test.ts).
 */

vi.mock('@civitai/next-axiom', () => ({
  withAxiom:
    (handler: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      handler(...args),
}));
// `allowedOrigins` at module load spreads `env.TRPC_ORIGINS` (must be iterable)
// and reads `env.NEXTAUTH_URL`; default everything else to undefined.
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
import { PublicEndpoint } from '../endpoint-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

const PUBLIC_DEFAULT = 'public, s-maxage=300, stale-while-revalidate=150';
const PRIVATE_DEFAULT = 'max-age=0, private, no-cache';
const EXPECTED_VARY = 'Cookie, Authorization';

const SECURE_SESSION_COOKIE = sessionCookieName(true);
const DEV_SESSION_COOKIE = sessionCookieName(false);
const SECURE_LEGACY_COOKIE = legacySessionCookieName(true);
const DEV_LEGACY_COOKIE = legacySessionCookieName(false);

const CREDENTIAL_COOKIES: [string, string][] = [
  ['current secure session cookie', SECURE_SESSION_COOKIE],
  ['current dev session cookie', DEV_SESSION_COOKIE],
  ['legacy secure session cookie', SECURE_LEGACY_COOKIE],
  ['legacy dev session cookie', DEV_LEGACY_COOKIE],
];

type HeaderBag = Record<string, string | string[]>;
type ReqArgs = {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
};

function makeReqRes({ method = 'GET', cookies, headers: reqHeaders = {} }: ReqArgs = {}) {
  const headers: HeaderBag = {};
  const req = { method, headers: reqHeaders, query: {}, cookies } as never;
  const res = {
    setHeader: vi.fn((k: string, v: string | string[]) => {
      headers[k] = v;
    }),
    getHeader: (k: string) => headers[k],
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as never;
  return { req, res, headers };
}

async function runPublicEndpoint(args: ReqArgs, opts: { maxAge?: number } = {}) {
  const { req, res, headers } = makeReqRes(args);
  await PublicEndpoint(async () => undefined, ['GET'], opts)(req, res);
  return headers;
}

describe('auth cookie names are derived from @civitai/auth, not spelled out', () => {
  // The implementation must resolve these through the same helpers. A hardcoded
  // literal in the implementation keeps matching and keeps looking correct right
  // up until the cookie is renamed — which has already happened once, hence this
  // pair of assertions naming BOTH the current and the retired base.
  it('resolves the current session cookie in both the secure and dev spellings', () => {
    expect(SECURE_SESSION_COOKIE).toBe('__Secure-civ-token');
    expect(DEV_SESSION_COOKIE).toBe('civ-token');
  });

  it('resolves the legacy session cookie in both spellings', () => {
    expect(SECURE_LEGACY_COOKIE).toBe('__Secure-civitai-token');
    expect(DEV_LEGACY_COOKIE).toBe('civitai-token');
  });

  it('keeps the current and legacy names distinct', () => {
    expect(SECURE_SESSION_COOKIE).not.toBe(SECURE_LEGACY_COOKIE);
  });
});

describe('PublicEndpoint cache headers by caller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PRESERVES the public edge cache for an anonymous request', async () => {
    const headers = await runPublicEndpoint({});
    expect(headers['Cache-Control']).toBe(PUBLIC_DEFAULT);
  });

  it('PRESERVES the public edge cache when only unrelated cookies are present', async () => {
    // Negative control for the credential check: a guard that answered "has
    // credentials" for any cookie at all — or unconditionally — fails here while
    // passing every positive case below.
    const headers = await runPublicEndpoint({
      cookies: { ga_session: '1', theme: 'dark', 'civ-token-decoy': 'x' },
      headers: { cookie: 'ga_session=1; theme=dark; civ-token-decoy=x' },
    });
    expect(headers['Cache-Control']).toBe(PUBLIC_DEFAULT);
  });

  it('PRESERVES the per-endpoint maxAge override on the anonymous arm', async () => {
    const headers = await runPublicEndpoint({}, { maxAge: 3600 });
    expect(headers['Cache-Control']).toBe('public, s-maxage=3600, stale-while-revalidate=1800');
  });

  it.each(CREDENTIAL_COOKIES)(
    'does NOT mark the response publicly cacheable for a %s',
    async (_label, cookieName) => {
      const headers = await runPublicEndpoint({ cookies: { [cookieName]: 'abc' } });
      expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
      expect(headers['Cache-Control']).not.toContain('public,');
      expect(headers['Cache-Control']).not.toContain('s-maxage');
    }
  );

  it('does NOT mark the response publicly cacheable for an Authorization header', async () => {
    const headers = await runPublicEndpoint({ headers: { authorization: 'Bearer abc' } });
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });

  it('does NOT mark the response publicly cacheable when the session cookie arrives only on the raw Cookie header', async () => {
    // `req.cookies` is what Next parses for an API route; the raw header is the
    // fallback read, and it must not quietly degrade to "anonymous".
    const headers = await runPublicEndpoint({
      headers: { cookie: `ga_session=1; ${SECURE_SESSION_COOKIE}=abc; other=2` },
    });
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });

  it('never lets a longer per-endpoint maxAge re-enable public caching for a credentialed caller', async () => {
    const headers = await runPublicEndpoint(
      { cookies: { [SECURE_SESSION_COOKIE]: 'abc' } },
      { maxAge: 86400 }
    );
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
  });
});

describe('PublicEndpoint Vary', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each<[string, ReqArgs]>([
    ['anonymous', {}],
    ['session cookie', { cookies: { [SECURE_SESSION_COOKIE]: 'abc' } }],
    ['Authorization header', { headers: { authorization: 'Bearer abc' } }],
    ['unrelated cookies', { cookies: { theme: 'dark' } }],
  ])('declares Vary on the %s arm', async (_label, args) => {
    const headers = await runPublicEndpoint(args);
    expect(headers['Vary']).toBe(EXPECTED_VARY);
  });

  it('declares Vary on an OPTIONS preflight, which returns before the handler', async () => {
    const { req, res, headers } = makeReqRes({ method: 'OPTIONS' });
    const handler = vi.fn(async () => undefined);
    await PublicEndpoint(handler, ['GET'])(req, res);

    expect(headers['Vary']).toBe(EXPECTED_VARY);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('PublicEndpoint handler override still wins (error arms stay uncacheable)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each<[string, ReqArgs]>([
    ['anonymous', {}],
    ['session cookie', { cookies: { [SECURE_SESSION_COOKIE]: 'abc' } }],
    ['Authorization header', { headers: { authorization: 'Bearer abc' } }],
  ])('lets a handler set no-store over the wrapper default (%s)', async (_label, args) => {
    // Mirrors the shed/error arms: `handleEndpointError`'s `no-store, max-age=0`
    // and the 503 arms in v1/images + v1/users, all of which set the header from
    // INSIDE the handler and must remain authoritative on either arm.
    const { req, res, headers } = makeReqRes(args);
    await PublicEndpoint(
      async (_req, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.status(503).json({ error: 'Server busy, please retry shortly.' });
      },
      ['GET']
    )(req, res);

    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });
});

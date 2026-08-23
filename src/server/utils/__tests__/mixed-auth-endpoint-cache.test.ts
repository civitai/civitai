import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `MixedAuthEndpoint` decides the same thing `PublicEndpoint` decides — whether a
 * response may be marked publicly cacheable — but it used to decide it on a
 * different axis, and to say less.
 *
 * Three properties are pinned here:
 *
 *   1. **The branch is on the CREDENTIAL, not on the resolved session.** The old
 *      `if (!session) addPublicCacheHeaders(...)` asks whether the credential
 *      WORKED; this asks whether one was PRESENTED. They disagree exactly when a
 *      credential is presented and fails to resolve — an expired cookie, a
 *      revoked api key, a session-store miss — and on that disagreement the old
 *      form takes the public arm. The `credential presented, session null` case
 *      below is the one that separates them.
 *   2. **The credentialed arm states a header.** It previously stated nothing and
 *      relied on `apiCacheMiddleware`, whose matcher is `/api/trpc/*` and
 *      `/api/v1/*` only. Two of this wrapper's twelve routes sit outside that:
 *      `/api/auth/freshdesk` (a 302 whose `Location` carries a per-user JWT),
 *      which had no `Cache-Control` at all, and the 404 arms of
 *      `/api/blocks/screenshot/[appBlockId]/[file]` — whose 200 arm sets its own
 *      header and still wins, as the override test below pins.
 *   3. **Every response declares a `Vary`.** It previously declared none.
 *
 * The anonymous arm is UNCHANGED, and the first test is what proves it: a change
 * that stopped edge-caching the logged-out population would be a straight
 * regression, which is a worse outcome than the gap being closed.
 *
 * Expected header values are LITERALS, never re-derived from the implementation's
 * constants, so this file is meaningful against code that predates them.
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
vi.mock('~/server/db/db-helpers', () => ({ checkNotUpToDate: vi.fn(async () => false) }));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/utils/key-generator', () => ({ generateSecretHash: vi.fn() }));
vi.mock('~/server/utils/server-domain', () => ({ getAllServerHosts: vi.fn(() => []) }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/utils/errorHandling', () => ({ isClientAbortError: vi.fn(() => false) }));

import { sessionCookieName } from '@civitai/auth';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { MixedAuthEndpoint } from '../endpoint-helpers';
import { createRealApiPair } from './real-api-response';
import { dbMock } from '~/__tests__/mocks/db.mock';

const PUBLIC_DEFAULT = 'public, s-maxage=300, stale-while-revalidate=150';
const PRIVATE_DEFAULT = 'max-age=0, private, no-cache';
const ANONYMOUS_VARY = 'Authorization';
const CREDENTIALED_VARY = 'Authorization, Cookie';

const SESSION_COOKIE = sessionCookieName(true);
const A_SESSION = { user: { id: 1, username: 'someone' } } as never;

const mockedSession = vi.mocked(getServerAuthSession);

type HeaderBag = Record<string, string | string[]>;
type ReqArgs = {
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  query?: Record<string, string | string[]>;
  url?: string;
};

function makeReqRes({
  method = 'GET',
  cookies,
  headers: reqHeaders = {},
  query = {},
  url = '/api/v1/articles',
}: ReqArgs = {}) {
  const headers: HeaderBag = {};
  const req = { method, headers: reqHeaders, query, url, cookies } as never;
  const res = {
    setHeader: vi.fn((k: string, v: string | string[]) => {
      headers[k] = v;
    }),
    getHeader: (k: string) => headers[k],
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
  } as never;
  return { req, res, headers };
}

async function runMixedAuth(args: ReqArgs, allowedMethods: string[] = ['GET']) {
  const { req, res, headers } = makeReqRes(args);
  await MixedAuthEndpoint(async () => undefined, allowedMethods)(req, res);
  return headers;
}

describe('MixedAuthEndpoint — the anonymous arm is preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(null);
  });

  it('PRESERVES the public edge cache for an anonymous request', async () => {
    const headers = await runMixedAuth({});
    expect(headers['Cache-Control']).toBe(PUBLIC_DEFAULT);
  });

  it('PRESERVES the public edge cache when only unrelated cookies are present', async () => {
    // Negative control: a predicate that answered "credentialed" for any cookie —
    // or unconditionally — fails here while passing every positive case below.
    const headers = await runMixedAuth({
      cookies: { _ga_ABC: '1', theme: 'dark', 'civ-token-decoy': 'x' },
      headers: { cookie: '_ga_ABC=1; theme=dark; civ-token-decoy=x' },
    });
    expect(headers['Cache-Control']).toBe(PUBLIC_DEFAULT);
  });

  it('never names Cookie in the Vary of a publicly cacheable response', async () => {
    const headers = await runMixedAuth({ cookies: { _ga_ABC: '1', __cf_bm: 'x' } });
    expect(headers['Cache-Control']).toBe(PUBLIC_DEFAULT);
    expect(headers['Vary']).toBe(ANONYMOUS_VARY);
    expect(String(headers['Vary'])).not.toContain('Cookie');
  });
});

describe('MixedAuthEndpoint — a credentialed request is not publicly cacheable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(A_SESSION);
  });

  it.each<[string, ReqArgs]>([
    ['session cookie', { cookies: { [SESSION_COOKIE]: 'abc' } }],
    ['Authorization header', { headers: { authorization: 'Bearer abc' } }],
    ['?token= api key', { query: { token: 'abc' }, url: '/api/v1/articles?token=abc' }],
  ])('states the private default for a %s', async (_label, args) => {
    const headers = await runMixedAuth(args);
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
    expect(headers['Cache-Control']).not.toContain('public');
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });

  it('declares Vary: Authorization, Cookie on the credentialed arm', async () => {
    const headers = await runMixedAuth({ cookies: { [SESSION_COOKIE]: 'abc' } });
    expect(headers['Vary']).toBe(CREDENTIALED_VARY);
  });

  it('states the private default on a route outside the /api/v1 matcher', async () => {
    // `/api/auth/freshdesk` is the sharp one: the proxy default does not reach it,
    // so before this it answered with no `Cache-Control` at all.
    const headers = await runMixedAuth({
      url: '/api/auth/freshdesk?nonce=n&state=s',
      cookies: { [SESSION_COOKIE]: 'abc' },
    });
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
  });
});

describe('MixedAuthEndpoint — a credential that does not resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The discriminating fixture: a credential IS presented and the session store
    // returns nothing. Branching on `!session` takes the PUBLIC arm here;
    // branching on the credential takes the private one.
    mockedSession.mockResolvedValue(null);
  });

  it('does not fall back to the public arm when a presented session cookie fails to resolve', async () => {
    const headers = await runMixedAuth({ cookies: { [SESSION_COOKIE]: 'expired' } });
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
    expect(headers['Cache-Control']).not.toContain('s-maxage');
  });

  it('does not fall back to the public arm when a presented api key fails to resolve', async () => {
    const headers = await runMixedAuth({
      query: { token: 'revoked' },
      url: '/api/v1/articles?token=revoked',
    });
    expect(headers['Cache-Control']).toBe(PRIVATE_DEFAULT);
  });
});

describe('MixedAuthEndpoint — a handler override still wins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(null);
  });

  it.each<[string, ReqArgs]>([
    ['anonymous', {}],
    ['credentialed', { cookies: { [SESSION_COOKIE]: 'abc' } }],
  ])('lets a handler set its own Cache-Control (%s)', async (_label, args) => {
    // `/api/blocks/screenshot/…` does exactly this on its 200 arm, and must keep
    // doing it: the wrapper states a default, the handler states the truth.
    const { req, res, headers } = makeReqRes(args);
    await MixedAuthEndpoint(
      async (_req, response) => {
        response.setHeader('Cache-Control', 'public, max-age=300');
        response.status(200).send('bytes');
      },
      ['GET']
    )(req, res);

    expect(headers['Cache-Control']).toBe('public, max-age=300');
  });
});

/**
 * 🔴 Driven through a REAL `http.ServerResponse` — see `real-api-response.ts` for
 * why a fake cannot express this. `addCorsHeaders` ends an OPTIONS preflight, and
 * against the real class every later `setHeader` throws `ERR_HTTP_HEADERS_SENT`.
 *
 * This wrapper reaches that path only for a route that lists OPTIONS in its
 * allowed methods (an OPTIONS request to a `['GET']` route is answered 405 before
 * CORS runs), so the allowed set is stated explicitly here.
 */
describe('MixedAuthEndpoint against a real http.ServerResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue(null);
  });

  it('answers an OPTIONS preflight with no post-end() header write', async () => {
    const { req, res, header } = createRealApiPair({ method: 'OPTIONS' });
    const handler = vi.fn(async () => undefined);

    await expect(MixedAuthEndpoint(handler, ['GET', 'OPTIONS'])(req, res)).resolves.toBeUndefined();

    expect(res.headersSent, 'the preflight must have been answered').toBe(true);
    expect(res.statusCode).toBe(200);
    expect(header('Vary')).toBe(ANONYMOUS_VARY);
    expect(handler).not.toHaveBeenCalled();
    // The preflight must not have paid for a session resolve it cannot use.
    expect(mockedSession).not.toHaveBeenCalled();
  });

  it('sets both headers on a GET, where nothing has ended the response', async () => {
    // The positive control for the fixture: without it, the case above cannot
    // distinguish "the ordering is right" from "no headers are written at all".
    const { req, res, header } = createRealApiPair({ method: 'GET' });

    await expect(
      MixedAuthEndpoint(async () => undefined, ['GET'])(req, res)
    ).resolves.toBeUndefined();

    expect(res.headersSent, 'a GET must not have flushed headers').toBe(false);
    expect(header('Cache-Control')).toBe(PUBLIC_DEFAULT);
    expect(header('Vary')).toBe(ANONYMOUS_VARY);
  });
});

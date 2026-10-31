import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TokenScope } from '@civitai/auth/token-scope';

/**
 * `/api/auth/oauth/authorize` refuses a client_credentials-only scope before the consent check, so a
 * user is never asked for it and an approval never stores it on a consent row. A registered app staff
 * marked `skipConsent` goes straight to code issuance with no consent screen.
 */

const h = vi.hoisted(() => ({
  inserts: [] as unknown[],
  authorize: vi.fn(),
  consent: undefined as unknown,
  skipConsent: false,
  isFirstParty: false,
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom() {
      const qb: Record<string, unknown> = {};
      qb.select = () => qb;
      qb.where = () => qb;
      qb.executeTakeFirst = () => Promise.resolve(h.consent);
      return qb;
    },
    insertInto() {
      const qb: Record<string, unknown> = {};
      qb.values = (v: unknown) => {
        h.inserts.push(v);
        return qb;
      };
      qb.onConflict = () => qb;
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
  },
}));
vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { authorize: h.authorize } }));
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: async () => true }));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ storeOidcContext: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/device', () => ({
  getOrCreateDeviceId: () => 'dev',
  touchAccount: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/auth/pending-authz', () => ({
  resolveAuthorizingUser: async () => ({ id: 7 }),
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));
vi.mock('$lib/server/oauth/access', () => ({ checkClientAccess: async () => ({ allowed: true }) }));
vi.mock('$lib/server/oauth/model', () => ({
  authorizeRedirectUriStore: new AsyncLocalStorage<string>(),
  resolveClientLite: async () => ({
    id: 'game-frame',
    grants: ['authorization_code', 'client_credentials'],
    redirectUris: ['https://games.example.com/cb', 'http://localhost:18188/cb'],
    isFirstParty: h.isFirstParty,
    accessMode: 'open',
    skipConsent: h.skipConsent,
  }),
}));

import { GET, POST } from '../+server';
import { storeOidcContext } from '$lib/server/oauth/oidc-nonce';

function approve(
  scope: number,
  headers: Record<string, string> = { origin: 'https://auth.civitai.com' }
) {
  const body = new URLSearchParams({
    client_id: 'game-frame',
    redirect_uri: 'https://games.example.com/cb',
    response_type: 'code',
    state: 's',
    code_challenge: 'c',
    code_challenge_method: 'S256',
    scope: String(scope),
    approved: 'true',
    remember: 'true',
  });
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  return POST({
    request: new Request(url, { method: 'POST', body, headers }),
    url,
    locals: { user: { id: 7 } },
    getClientAddress: () => '203.0.113.9',
    cookies: { get: () => undefined, set: () => undefined },
  } as never);
}

beforeEach(() => {
  h.inserts.length = 0;
  h.authorize.mockReset();
  h.consent = undefined;
  h.skipConsent = false;
  h.isFirstParty = false;
});

/** A sign-in starting at /authorize (no approval yet). Returns the response, or the redirect it throws. */
async function start(
  overrides: Record<string, string> = {},
  locals: Record<string, unknown> = { user: { id: 7 } }
): Promise<{ status: number; location?: string }> {
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  for (const [k, v] of Object.entries({
    client_id: 'game-frame',
    redirect_uri: 'https://games.example.com/cb',
    response_type: 'code',
    state: 's',
    code_challenge: 'c',
    code_challenge_method: 'S256',
    scope: String(TokenScope.UserRead),
    ...overrides,
  }))
    url.searchParams.set(k, v);
  try {
    const res = await GET({
      request: new Request(url),
      url,
      locals,
      getClientAddress: () => '203.0.113.9',
      cookies: { get: () => undefined, set: () => undefined },
    } as never);
    return { status: res.status };
  } catch (e) {
    const r = e as { status?: number; location?: string };
    if (typeof r.status === 'number' && r.location)
      return { status: r.status, location: r.location };
    throw e;
  }
}

/** The `error` an error redirect back to the client carries (the redirect_uri is verified by then). */
async function redirectedError(pending: Response | Promise<Response>): Promise<string | null> {
  const thrown = await Promise.resolve(pending).then(
    () => null,
    (e: unknown) => e
  );
  const location = (thrown as { location?: string } | null)?.location;
  return location ? new URL(location).searchParams.get('error') : null;
}

describe('authorize — client_credentials-only scopes', () => {
  it('refuses AppStoreCatalogWrite before storing any consent or issuing a code', async () => {
    const error = await redirectedError(
      approve(TokenScope.UserRead | TokenScope.AppStoreCatalogWrite)
    );
    expect(error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('refuses WorkerRegister before storing any consent or issuing a code', async () => {
    const error = await redirectedError(approve(TokenScope.UserRead | TokenScope.WorkerRegister));
    expect(error).toBe('invalid_scope');
    expect(h.inserts).toHaveLength(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('stores the consent for an ordinary scope (positive control)', async () => {
    h.authorize.mockRejectedValueOnce(new Error('stop after consent'));
    await Promise.resolve(approve(TokenScope.UserRead)).catch(() => undefined);
    expect(h.inserts).toEqual([
      expect.objectContaining({ userId: 7, clientId: 'game-frame', scope: TokenScope.UserRead }),
    ]);
  });
});

describe('authorize — approval comes from the consent page', () => {
  beforeEach(() => {
    h.authorize.mockRejectedValue(new Error('code issued'));
  });

  it('refuses an approval from another origin before storing consent or issuing a code', async () => {
    const res = await approve(TokenScope.UserRead, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('access_denied');
    expect(h.inserts).toHaveLength(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('refuses an approval naming no origin', async () => {
    const res = await approve(TokenScope.UserRead, {});
    expect(res.status).toBe(403);
    expect(h.inserts).toHaveLength(0);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('accepts an approval whose Referer is the consent page', async () => {
    await Promise.resolve(
      approve(TokenScope.UserRead, {
        referer: 'https://auth.civitai.com/login/oauth/authorize?x=1',
      })
    ).catch(() => undefined);
    expect(h.inserts).toHaveLength(1);
  });
});

describe('authorize — consent screen', () => {
  beforeEach(() => {
    h.authorize.mockRejectedValue(new Error('code issued'));
  });

  it('sends a registered app to the consent page by default', async () => {
    const res = await start();
    expect(res.status).toBe(303);
    expect(res.location).toContain('/login/oauth/authorize?');
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('skips it for an app staff marked skipConsent, storing no consent row', async () => {
    h.skipConsent = true;
    await start().catch(() => undefined);
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.inserts).toHaveLength(0);
  });
});

describe('authorize — skipConsent needs the exact registered redirect', () => {
  const consentPage = (res: { location?: string }) =>
    res.location?.includes('/login/oauth/authorize?') ?? false;

  beforeEach(() => {
    h.skipConsent = true;
    h.authorize.mockResolvedValue({ authorizationCode: 'the-code' });
  });

  it('issues a code with no consent screen for an exact match', async () => {
    const res = await start();
    expect(res.location).toBe('https://games.example.com/cb?code=the-code&state=s');
  });

  it.each([
    ['a loopback port variant', 'http://localhost:9999/cb'],
    ['an added query string', 'http://localhost:18188/cb?next=1'],
  ])('shows the consent page for %s', async (_, redirect_uri) => {
    const res = await start({ redirect_uri });
    expect(consentPage(res)).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('shows the consent page for an exact match on a registered http://localhost redirect', async () => {
    const res = await start({ redirect_uri: 'http://localhost:18188/cb' });
    expect(consentPage(res)).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('shows the consent page for prompt=consent', async () => {
    const res = await start({ prompt: 'consent' });
    expect(consentPage(res)).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('still skips for a first-party client, port variant and prompt=consent included', async () => {
    h.isFirstParty = true;
    const res = await start({ redirect_uri: 'http://localhost:9999/cb', prompt: 'consent' });
    expect(res.location).toBe('http://localhost:9999/cb?code=the-code&state=s');
  });
});

describe('authorize — family', () => {
  beforeEach(() => {
    h.skipConsent = true;
    h.isFirstParty = true;
    h.authorize.mockResolvedValue({ authorizationCode: 'the-code' });
    vi.mocked(storeOidcContext).mockClear();
  });

  it("hands the hub session's family to the site's session", async () => {
    const session = { sub: '7', jti: 'j', sid: 'family-a', iat0: 5 };
    await start({}, { user: { id: 7 }, session });
    expect(storeOidcContext).toHaveBeenCalledWith(
      'the-code',
      expect.objectContaining({ family: 'family-a', iat0: 5 })
    );
  });

  it('hands over no family when the code is for a different account than the hub session', async () => {
    const session = { sub: '8', jti: 'j', sid: 'family-b', iat0: 5 };
    await start({}, { user: { id: 7 }, session });
    expect(storeOidcContext).toHaveBeenCalledWith(
      'the-code',
      expect.objectContaining({ family: undefined, iat0: undefined })
    );
  });
});

describe('authorize — scope in a JSON body', () => {
  it.each([[['ModelsRead']], [5]])('answers invalid_scope for %j', async (scope) => {
    const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
    const pending = POST({
      request: new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: 'game-frame',
          redirect_uri: 'https://games.example.com/cb',
          response_type: 'code',
          state: 's',
          code_challenge: 'c',
          code_challenge_method: 'S256',
          scope,
        }),
      }),
      url,
      locals: { user: { id: 7 } },
      getClientAddress: () => '203.0.113.9',
      cookies: { get: () => undefined, set: () => undefined },
    } as never);
    expect(await redirectedError(pending)).toBe('invalid_scope');
  });
});

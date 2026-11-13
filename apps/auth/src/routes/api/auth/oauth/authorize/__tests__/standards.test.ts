import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { TokenScope } from '@civitai/auth/token-scope';

/**
 * `/api/auth/oauth/authorize` against the standards a generic OAuth / OIDC library assumes: scope names
 * and `openid` (RFC 6749 §3.3, OIDC Core §3.1.2.1), errors sent back to a verified redirect_uri
 * (RFC 6749 §4.1.2.1), and the `prompt` values (OIDC Core §3.1.2.1).
 */

const h = vi.hoisted(() => ({
  user: { id: 7 } as { id: number } | null,
  consent: undefined as { scope: number } | undefined,
  rateLimitAllowed: true,
  firstParty: false,
  skipConsent: false,
  rateLimitCalls: [] as string[],
  clientLookups: 0,
  authorize: vi.fn(),
  storeOidcContext: vi.fn(async () => undefined),
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
      qb.values = () => qb;
      qb.onConflict = () => qb;
      qb.execute = () => Promise.resolve([]);
      return qb;
    },
  },
}));
vi.mock('$lib/server/oauth/server', () => ({ oauthServer: { authorize: h.authorize } }));
vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: async (bucket: string) => {
    h.rateLimitCalls.push(bucket);
    return h.rateLimitAllowed;
  },
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn() }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({ storeOidcContext: h.storeOidcContext }));
vi.mock('$lib/server/auth/device', () => ({
  getOrCreateDeviceId: () => 'dev',
  touchAccount: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/auth/pending-authz', () => ({
  resolveAuthorizingUser: async () => h.user,
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));
vi.mock('$lib/server/oauth/access', () => ({ checkClientAccess: async () => ({ allowed: true }) }));
vi.mock('$lib/server/oauth/model', () => ({
  authorizeRedirectUriStore: new AsyncLocalStorage<string>(),
  resolveClientLite: async () => (
    h.clientLookups++,
    {
      id: 'game-frame',
      grants: ['authorization_code'],
      redirectUris: ['https://games.example.com/cb'],
      isFirstParty: h.firstParty,
      // First-party clients always skip consent (resolveClientLite).
      skipConsent: h.firstParty || h.skipConsent,
      accessMode: 'open',
    }
  ),
}));

import { GET, POST } from '../+server';

const BASE = {
  client_id: 'game-frame',
  redirect_uri: 'https://games.example.com/cb',
  response_type: 'code',
  state: 's1',
  code_challenge: 'c',
  code_challenge_method: 'S256',
  scope: String(TokenScope.UserRead),
};

type Outcome = { status: number; location?: URL; body?: Record<string, unknown> };

/** Run the endpoint and report where it sent the browser, or the JSON it answered with. */
async function run(pending: Response | Promise<Response>): Promise<Outcome> {
  try {
    const res = await pending;
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      location: undefined,
    };
  } catch (e) {
    const r = e as { status?: number; location?: string };
    if (!r.location) throw e;
    return { status: r.status ?? 0, location: new URL(r.location, 'https://auth.civitai.com') };
  }
}

function get(params: Record<string, string>) {
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  for (const [k, v] of Object.entries({ ...BASE, ...params })) url.searchParams.set(k, v);
  return run(
    GET({
      request: new Request(url),
      url,
      locals: { user: h.user },
      getClientAddress: () => '203.0.113.9',
      cookies: { get: () => undefined, set: () => undefined },
    } as never)
  );
}

function approve(params: Record<string, string>) {
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  const body = new URLSearchParams({ ...BASE, approved: 'true', ...params });
  return run(
    POST({
      request: new Request(url, {
        method: 'POST',
        body,
        headers: { origin: 'https://auth.civitai.com' },
      }),
      url,
      locals: { user: h.user },
      getClientAddress: () => '203.0.113.9',
      cookies: { get: () => undefined, set: () => undefined },
    } as never)
  );
}

const toClient = (o: Outcome) =>
  o.location?.origin === 'https://games.example.com' ? o.location.searchParams : null;

beforeEach(() => {
  h.user = { id: 7 };
  h.consent = { scope: TokenScope.Full };
  h.rateLimitAllowed = true;
  h.firstParty = false;
  h.skipConsent = false;
  h.rateLimitCalls = [];
  h.clientLookups = 0;
  h.authorize.mockReset();
  h.authorize.mockResolvedValue({ authorizationCode: 'code-1' });
  h.storeOidcContext.mockClear();
});

describe('authorize — scope names and openid', () => {
  it('accepts scope names and hands the library the bitmask', async () => {
    const out = await get({ scope: 'openid ModelsRead MediaRead' });
    expect(toClient(out)?.get('code')).toBe('code-1');
    const body = (h.authorize.mock.calls[0][0] as { body: Record<string, string> }).body;
    expect(body.scope).toBe(String(TokenScope.ModelsRead | TokenScope.MediaRead));
  });

  it('records an openid request so /token issues an id_token without a nonce', async () => {
    await get({ scope: 'openid profile' });
    expect(h.storeOidcContext).toHaveBeenCalledWith(
      'code-1',
      expect.objectContaining({ openid: true, nonce: undefined })
    );
  });

  it('still accepts the decimal bitmask', async () => {
    const out = await get({ scope: String(TokenScope.ModelsRead) });
    expect(toClient(out)?.get('code')).toBe('code-1');
  });

  it('sends a missing scope back to the client as invalid_scope', async () => {
    const out = await get({ scope: '' });
    expect(toClient(out)?.get('error')).toBe('invalid_scope');
  });

  it('sends an unknown scope name back to the client as invalid_scope', async () => {
    const out = await get({ scope: 'ModelsRead NotAScope' });
    expect(toClient(out)?.get('error')).toBe('invalid_scope');
    expect(toClient(out)?.get('state')).toBe('s1');
    expect(h.authorize).not.toHaveBeenCalled();
  });
});

describe('authorize — errors go back to a verified redirect_uri', () => {
  it('redirects a missing PKCE challenge to the client with its state', async () => {
    const out = await get({ code_challenge: '' });
    expect(toClient(out)?.get('error')).toBe('invalid_request');
    expect(toClient(out)?.get('state')).toBe('s1');
  });

  it('answers in JSON, never redirecting, when the redirect_uri is not registered', async () => {
    const out = await get({ redirect_uri: 'https://evil.example/cb' });
    expect(out.status).toBe(400);
    expect(out.location).toBeUndefined();
    expect(out.body?.error).toBe('invalid_request');
  });

  it('turns a library 4xx into an error redirect', async () => {
    h.authorize.mockRejectedValueOnce(
      Object.assign(new Error('Invalid scope'), { name: 'invalid_scope', code: 400 })
    );
    const out = await get({ scope: 'ModelsRead' });
    expect(toClient(out)?.get('error')).toBe('invalid_scope');
  });

  it('never passes a 5xx message on to the client', async () => {
    h.authorize.mockRejectedValueOnce(new Error('connection refused at 10.0.0.5'));
    const out = await get({ scope: 'ModelsRead' });
    expect(toClient(out)?.get('error')).toBe('server_error');
    expect(toClient(out)?.get('error_description')).toBeNull();
  });
});

describe('authorize — prompt', () => {
  it('prompt=none: a signed-out user is login_required at the client', async () => {
    h.user = null;
    const out = await get({ prompt: 'none' });
    expect(toClient(out)?.get('error')).toBe('login_required');
    expect(toClient(out)?.get('state')).toBe('s1');
  });

  it('prompt=none: an app the user has not approved is consent_required', async () => {
    h.consent = undefined;
    const out = await get({ prompt: 'none' });
    expect(toClient(out)?.get('error')).toBe('consent_required');
  });

  it('prompt=none: an approved app gets its code without any screen', async () => {
    const out = await get({ prompt: 'none' });
    expect(toClient(out)?.get('code')).toBe('code-1');
  });

  it('prompt=none cannot be combined with another value', async () => {
    const out = await get({ prompt: 'none consent' });
    expect(toClient(out)?.get('error')).toBe('invalid_request');
  });

  it('prompt=consent shows the consent screen despite a remembered consent', async () => {
    const out = await get({ prompt: 'consent' });
    expect(out.location?.pathname).toBe('/login/oauth/authorize');
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('prompt=select_account opens the consent screen with the prompt, for its account picker', async () => {
    const out = await get({ prompt: 'select_account' });
    expect(out.location?.pathname).toBe('/login/oauth/authorize');
    expect(out.location?.searchParams.get('prompt')).toBe('select_account');
  });

  it('prompt=login with a session is login_required: the hub cannot force a fresh sign-in', async () => {
    const out = await get({ prompt: 'login' });
    expect(toClient(out)?.get('error')).toBe('login_required');
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('prompt=login while signed out signs in, then returns without `login`', async () => {
    h.user = null;
    const out = await get({ prompt: 'login' });
    expect(out.location?.pathname).toBe('/login');
    const returnUrl = new URL(
      out.location!.searchParams.get('returnUrl')!,
      'https://auth.civitai.com'
    );
    expect(returnUrl.searchParams.has('prompt')).toBe(false);
  });

  it('ignores prompt values it does not know', async () => {
    const out = await get({ prompt: 'create' });
    expect(toClient(out)?.get('code')).toBe('code-1');
  });
});

describe('authorize — signing in first keeps what the prompt still owes', () => {
  const returnUrl = (o: Outcome) =>
    new URL(o.location!.searchParams.get('returnUrl')!, 'https://auth.civitai.com');

  it('keeps prompt=consent on the way back from signing in', async () => {
    h.user = null;
    const out = await get({ prompt: 'consent' });
    expect(out.location?.pathname).toBe('/login');
    expect(returnUrl(out).searchParams.get('prompt')).toBe('consent');
  });

  it('drops only `login`, which signing in satisfies', async () => {
    h.user = null;
    const out = await get({ prompt: 'login select_account' });
    expect(returnUrl(out).searchParams.get('prompt')).toBe('select_account');
  });

  it('prompt=none while signed out answers in JSON for an unregistered redirect_uri', async () => {
    h.user = null;
    const out = await get({ prompt: 'none', redirect_uri: 'https://evil.example/cb' });
    expect(out.status).toBe(400);
    expect(out.location).toBeUndefined();
  });

  it('prompt=none while signed out is rate limited by IP before the client lookup', async () => {
    h.user = null;
    h.rateLimitAllowed = false;
    const out = await get({ prompt: 'none' });
    expect(out.status).toBe(429);
    expect(h.rateLimitCalls).toEqual(['authorize-anon']);
    expect(h.clientLookups).toBe(0);
  });
});

describe('authorize — first-party spokes', () => {
  it('answers an error in JSON rather than redirecting, which would loop through the spoke', async () => {
    h.firstParty = true;
    const out = await get({ code_challenge: '' });
    expect(out.location).toBeUndefined();
    expect(out.status).toBe(400);
    expect(out.body?.error).toBe('invalid_request');
  });

  it('answers a library failure as a JSON 500 without its message', async () => {
    h.firstParty = true;
    h.authorize.mockRejectedValueOnce(new Error('connection refused at 10.0.0.5'));
    const out = await get({});
    expect(out.status).toBe(500);
    expect(out.body).toEqual({ error: 'server_error' });
  });
});

describe('authorize — openid through the consent page', () => {
  it('an approval carrying `openid <bitmask>` records the openid request', async () => {
    h.consent = undefined;
    const out = await approve({ scope: `openid ${TokenScope.UserRead}` });
    expect(toClient(out)?.get('code')).toBe('code-1');
    expect(h.storeOidcContext).toHaveBeenCalledWith(
      'code-1',
      expect.objectContaining({ openid: true })
    );
  });
});

describe('authorize — skipConsent apps', () => {
  it('get their code with no consent screen', async () => {
    h.skipConsent = true;
    h.consent = undefined;
    const out = await get({});
    expect(toClient(out)?.get('code')).toBe('code-1');
  });

  it('still open the account picker for prompt=select_account', async () => {
    h.skipConsent = true;
    const out = await get({ prompt: 'select_account' });
    expect(out.location?.pathname).toBe('/login/oauth/authorize');
    expect(out.location?.searchParams.get('prompt')).toBe('select_account');
  });

  it('issue the code when the picker is approved, without storing consent', async () => {
    h.skipConsent = true;
    const out = await approve({});
    expect(toClient(out)?.get('code')).toBe('code-1');
  });
});

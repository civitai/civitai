import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';

const h = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  fetchProfile: vi.fn(),
  linkAccountToUser: vi.fn(),
  findOrCreateUser: vi.fn(),
  establishSession: vi.fn(),
  logToAxiom: vi.fn<(data: Record<string, unknown>) => Promise<void>>(async () => undefined),
}));

vi.mock('$lib/server/auth/providers', async (importOriginal) => ({
  NO_PKCE_COOKIE: (await importOriginal<{ NO_PKCE_COOKIE: string }>()).NO_PKCE_COOKIE,
  getProvider: (id: string) =>
    id === 'discord'
      ? { id: 'discord', incrementalSkipsPkce: true }
      : id === 'github'
      ? { id: 'github' }
      : undefined,
  exchangeCode: h.exchangeCode,
  fetchProfile: h.fetchProfile,
  isStubProviderEnabled: () => false,
}));
vi.mock('$lib/server/auth/users', () => ({
  findOrCreateUser: h.findOrCreateUser,
  linkAccountToUser: h.linkAccountToUser,
  userExistsByEmail: vi.fn(async () => false),
  isLinkedAccount: vi.fn(async () => false),
}));
vi.mock('$lib/server/auth/blocklist', () => ({
  emailDomain: () => null,
  isBlockedEmailDomain: vi.fn(async () => false),
  normalizeEmailAddress: (e: string) => e,
}));
vi.mock('$lib/server/auth/session', () => ({ establishSession: h.establishSession }));
vi.mock('$lib/server/oauth/first-party', () => ({
  buildPostLoginOriginCheck: async () => () => true,
}));
vi.mock('$lib/server/metrics', () => ({
  blockedEmailDomainSignupsTotal: { inc: vi.fn() },
  loginsTotal: { inc: vi.fn() },
}));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: h.logToAxiom }));

import { GET } from '../+server';
import { NO_PKCE_COOKIE } from '$lib/server/auth/providers';

const LANDING = 'https://civitai.com/discord/link-role';

function callback(
  query: Record<string, string>,
  jar: Record<string, string>,
  user?: { id: number },
  provider = 'discord'
) {
  const url = new URL(`https://auth.civitai.com/login/${provider}/callback`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const deleted: string[] = [];
  const cookies = {
    get: (name: string) => jar[name],
    delete: (name: string) => deleted.push(name),
    set: vi.fn(),
  };
  const run = async () => {
    try {
      await GET({ params: { provider }, url, cookies, locals: { user } } as never);
    } catch (e) {
      return e;
    }
    throw new Error('handler returned without redirecting or erroring');
  };
  return { run, deleted };
}

const linkJar = {
  oauth_state: 'st-1',
  oauth_verifier: 'ver-1',
  oauth_return: LANDING,
  oauth_link: '1',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.exchangeCode.mockResolvedValue({ accessToken: 'at', scope: 'identify email' });
  h.fetchProfile.mockResolvedValue({ providerAccountId: '42', email: null, emailVerified: false });
  h.linkAccountToUser.mockResolvedValue('linked');
});

describe('provider error on the callback', () => {
  it('returns a link flow to its returnUrl with an error instead of a 400', async () => {
    const { run, deleted } = callback(
      { error: 'invalid_scope', error_description: 'nope', state: 'st-1' },
      linkJar,
      { id: 7 }
    );
    const thrown = await run();

    expect(isRedirect(thrown)).toBe(true);
    if (!isRedirect(thrown)) return;
    expect(thrown.status).toBe(302);
    expect(thrown.location).toBe(`${LANDING}?error=OAuthCallback`);
    expect(deleted).toEqual(
      expect.arrayContaining(['oauth_state', 'oauth_verifier', 'oauth_return', 'oauth_link'])
    );
    expect(h.exchangeCode).not.toHaveBeenCalled();
    expect(h.linkAccountToUser).not.toHaveBeenCalled();
  });

  it('maps a cancelled consent to AccessDenied', async () => {
    const thrown = await callback({ error: 'access_denied', state: 'st-1' }, linkJar, {
      id: 7,
    }).run();
    expect(isRedirect(thrown) && thrown.location).toBe(`${LANDING}?error=AccessDenied`);
  });

  it('sends a login flow back to the hub login page, keeping its returnUrl', async () => {
    const thrown = await callback(
      { error: 'invalid_scope', state: 'st-1' },
      { oauth_state: 'st-1', oauth_verifier: 'ver-1', oauth_return: '/models' }
    ).run();
    expect(isRedirect(thrown) && thrown.location).toBe(
      '/login?error=OAuthCallback&returnUrl=%2Fmodels'
    );
    expect(h.establishSession).not.toHaveBeenCalled();
  });

  it('does not reflect the provider error text into the redirect', async () => {
    const thrown = await callback({ error: '<script>x</script>', state: 'st-1' }, linkJar, {
      id: 7,
    }).run();
    expect(isRedirect(thrown) && thrown.location).toBe(`${LANDING}?error=OAuthCallback`);
  });

  it('logs the provider and error code, never the state or code values', async () => {
    await callback({ error: 'invalid_scope', state: 'st-1' }, linkJar, { id: 7 }).run();
    expect(h.logToAxiom).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(h.logToAxiom.mock.calls[0]);
    expect(h.logToAxiom.mock.calls[0][0]).toMatchObject({
      provider: 'discord',
      reason: 'provider_error',
      providerError: 'invalid_scope',
    });
    expect(logged).not.toContain('st-1');
    expect(logged).not.toContain('ver-1');
  });
});

describe('state check on a code callback', () => {
  it('still links when code, state and verifier all match (control)', async () => {
    const thrown = await callback({ code: 'c-1', state: 'st-1' }, linkJar, { id: 7 }).run();
    expect(isRedirect(thrown) && thrown.location).toBe(LANDING);
    expect(h.linkAccountToUser).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['state_mismatch', { code: 'c-1', state: 'st-OTHER' }, linkJar],
    ['no_cookie', { code: 'c-1', state: 'st-1' }, { ...linkJar, oauth_state: undefined }],
    ['no_cookie', { code: 'c-1', state: 'st-1' }, { ...linkJar, oauth_verifier: undefined }],
    ['no_code', { state: 'st-1' }, linkJar],
    ['no_code', { code: 'c-1' }, linkJar],
  ] as const)('refuses with 400 and logs %s', async (reason, query, jar) => {
    const thrown = await callback(query, jar as Record<string, string>, { id: 7 }).run();
    expect(isHttpError(thrown) && thrown.status).toBe(400);
    expect(h.exchangeCode).not.toHaveBeenCalled();
    expect(h.linkAccountToUser).not.toHaveBeenCalled();
    expect(h.logToAxiom.mock.calls[0]?.[0]).toMatchObject({ provider: 'discord', reason });
    const logged = JSON.stringify(h.logToAxiom.mock.calls);
    expect(logged).not.toContain('c-1');
    expect(logged).not.toContain('st-1');
  });

  it.each([
    ['matching', 'st-1'],
    ['mismatched', 'st-OTHER'],
  ])(
    'never exchanges a code that rides along with a provider error (%s state)',
    async (_, state) => {
      const thrown = await callback({ error: 'invalid_scope', code: 'c-1', state }, linkJar, {
        id: 7,
      }).run();
      expect(isRedirect(thrown) && thrown.location).toBe(`${LANDING}?error=OAuthCallback`);
      expect(h.exchangeCode).not.toHaveBeenCalled();
      expect(h.linkAccountToUser).not.toHaveBeenCalled();
    }
  );
});

describe('Discord roles leg without PKCE', () => {
  const rolesJar = {
    oauth_state: 'st-1',
    [NO_PKCE_COOKIE]: 'discord',
    oauth_return: LANDING,
    oauth_link: '1',
  };

  it('links without a verifier and sends no code_verifier on the exchange', async () => {
    const { run, deleted } = callback({ code: 'c-1', state: 'st-1' }, rolesJar, { id: 7 });
    const thrown = await run();
    expect(isRedirect(thrown) && thrown.location).toBe(LANDING);
    expect(h.exchangeCode).toHaveBeenCalledTimes(1);
    expect(h.exchangeCode.mock.calls[0][1]).toMatchObject({ code: 'c-1', codeVerifier: undefined });
    expect(h.linkAccountToUser).toHaveBeenCalledTimes(1);
    expect(deleted).toContain(NO_PKCE_COOKIE);
  });

  it('sends no code_verifier on the roles leg even if a stray verifier cookie is present', async () => {
    await callback(
      { code: 'c-1', state: 'st-1' },
      { ...rolesJar, oauth_verifier: 'stale' },
      { id: 7 }
    ).run();
    expect(h.exchangeCode.mock.calls[0][1]).toMatchObject({ codeVerifier: undefined });
  });

  it('still refuses a mismatched state on the roles leg', async () => {
    const thrown = await callback({ code: 'c-1', state: 'st-OTHER' }, rolesJar, { id: 7 }).run();
    expect(isHttpError(thrown) && thrown.status).toBe(400);
    expect(h.exchangeCode).not.toHaveBeenCalled();
  });

  it('a PKCE login leg still sends its verifier', async () => {
    await callback({ code: 'c-1', state: 'st-1' }, linkJar, { id: 7 }).run();
    expect(h.exchangeCode.mock.calls[0][1]).toMatchObject({ codeVerifier: 'ver-1' });
  });

  it.each([
    [
      'not a link flow',
      { oauth_state: 'st-1', [NO_PKCE_COOKIE]: 'discord', oauth_return: '/' },
      'discord',
    ],
    ['a provider without the flag', rolesJar, 'github'],
    ['a marker naming another provider', { ...rolesJar, [NO_PKCE_COOKIE]: 'github' }, 'discord'],
  ] as const)(
    'ignores the no-PKCE marker for %s, so a missing verifier still fails',
    async (_, jar, provider) => {
      const thrown = await callback(
        { code: 'c-1', state: 'st-1' },
        jar as Record<string, string>,
        { id: 7 },
        provider
      ).run();
      expect(isHttpError(thrown) && thrown.status).toBe(400);
      expect(h.exchangeCode).not.toHaveBeenCalled();
      expect(h.logToAxiom.mock.calls[0]?.[0]).toMatchObject({ reason: 'no_cookie' });
    }
  );
});

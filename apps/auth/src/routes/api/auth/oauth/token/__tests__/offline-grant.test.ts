import { createHash } from 'crypto';
import { unpack } from 'msgpackr';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as OAuthRateLimit from '$lib/server/oauth/rate-limit';
import type * as CivitaiAuth from '@civitai/auth';

/**
 * Offline access as a separate grant, end to end through the real /authorize and /token routes, the
 * OAuth library and the hub model, over one in-memory database and one in-memory redis. Stubbed: the
 * database and redis themselves, the Flipt read (the `oauth-offline-grant` flag), the rate limiter,
 * the audit log (asserted on), the session helpers /authorize needs, and the OIDC context store.
 */

const h = vi.hoisted(() => {
  // generateSecretHash salts with NEXTAUTH_SECRET, read once by @civitai/auth.
  process.env.NEXTAUTH_SECRET = `offline-grant-test-${Math.random()}`;
  return {
    tables: {} as Record<string, Record<string, unknown>[]>,
    flag: false,
    strings: new Map<string, { value: unknown; ex?: number }>(),
    hashes: new Map<string, Map<string, unknown>>(),
    events: [] as { type: string; userId?: number; clientId?: string }[],
    // Outbound calls (the orchestrator cache invalidations), as "METHOD path".
    fetches: [] as string[],
  };
});

vi.mock('$lib/server/db/db', async () => {
  const { createKyselyFake } = await import('../../../../../../test/kysely-fake');
  return { db: createKyselyFake(h.tables) };
});
vi.mock('$lib/server/redis', () => ({
  getRedis: () => ({
    packed: {
      async hGet(key: string, field: string) {
        const raw = h.hashes.get(key)?.get(field);
        return raw == null ? null : unpack(raw as Buffer);
      },
      async get(key: string) {
        return h.strings.get(key)?.value ?? null;
      },
      async set(key: string, value: unknown, opts?: { EX?: number }) {
        h.strings.set(key, { value: structuredClone(value), ex: opts?.EX });
        return 'OK';
      },
    },
    async hDel(key: string, field: string) {
      return h.hashes.get(key)?.delete(field) ? 1 : 0;
    },
    async eval(
      script: string,
      { keys, arguments: args }: { keys: string[]; arguments: unknown[] }
    ) {
      if (!script.includes("'HSET'")) throw new Error('redis fake: unexpected script');
      const hash = h.hashes.get(keys[0]) ?? new Map();
      hash.set(String(args[0]), args[1]);
      h.hashes.set(keys[0], hash);
      return 1;
    },
  }),
  getSysRedis: () => null,
  evalSys: async () => null,
}));
vi.mock('$lib/server/flipt', () => ({
  isGlobalFlagOn: async (flag: string) => flag === 'oauth-offline-grant' && h.flag,
}));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => undefined,
}));
vi.mock('$lib/server/oauth/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthRateLimit>()),
  checkOAuthRateLimit: vi.fn(async () => true),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({
  logOAuthEvent: vi.fn((e: { type: string; userId?: number; clientId?: string }) =>
    h.events.push({ type: e.type, userId: e.userId, clientId: e.clientId })
  ),
}));
vi.mock('$lib/server/axiom', () => ({
  logAxiomError: vi.fn(async () => undefined),
  logToAxiom: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => '203.0.113.30' }));
vi.mock('$lib/server/oauth/oidc-nonce', () => ({
  storeOidcContext: vi.fn(async () => true),
  consumeOidcContext: vi.fn(async () => null),
}));
vi.mock('$lib/server/auth/pending-authz', () => ({
  resolveAuthorizingUser: async (o: { sessionUser?: unknown }) => o.sessionUser,
}));
vi.mock('$lib/server/auth/session-producer', () => ({ getOrProduceSessionUser: vi.fn() }));
vi.mock('$lib/server/oauth/access', () => ({ checkClientAccess: async () => ({ allowed: true }) }));

import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { POST as TOKEN } from '../+server';
import { GET as AUTHORIZE_GET, POST as AUTHORIZE_POST } from '../../authorize/+server';
import { grantOffline } from '$lib/server/oauth/offline-grant';

const USER = 41;
const OTHER_USER = 42;
const CLIENT = 'offline-app';
const OTHER_CLIENT = 'other-app';
const DEVICE_CLIENT = 'cli-app';
const SYSTEM_CLIENT = 'system-app';
const DUAL_CLIENT = 'dual-app';
const RUNNER_CLIENT = 'recipe-runner';
const UNBOUND_CLIENT = 'system-confidential-app';
const REDIRECT = 'https://app.example/callback';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const DAY = 86_400_000;
const VERIFIER = 'v'.repeat(64);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function seed() {
  for (const k of Object.keys(h.tables)) delete h.tables[k];
  h.tables.User = [USER, OTHER_USER].map((id) => ({
    id,
    username: `u${id}`,
    deletedAt: null,
    bannedAt: null,
  }));
  const client = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    secret: null,
    name: id,
    isConfidential: false,
    grants: ['authorization_code', 'refresh_token'],
    allowedScopes: TokenScope.UserRead | TokenScope.ModelsRead,
    userId: 1,
    redirectUris: [REDIRECT],
    allowedOrigins: [],
    accessMode: 'open',
    skipConsent: false,
    ...over,
  });
  h.tables.OauthClient = [
    client(CLIENT),
    client(OTHER_CLIENT),
    client(DEVICE_CLIENT, {
      grants: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    }),
    client(DUAL_CLIENT, {
      grants: [
        'authorization_code',
        'urn:ietf:params:oauth:grant-type:device_code',
        'refresh_token',
      ],
    }),
    // A confidential app owned by the system account (-1) that skips the consent screen.
    client(SYSTEM_CLIENT, { isConfidential: true, secret: 'x', userId: -1, skipConsent: true }),
    // A recipe runner: system-owned, confidential, consented, open, no device grant, and bound.
    client(RUNNER_CLIENT, { isConfidential: true, secret: 'x', userId: -1 }),
    // The same shape with no binding: an ordinary app.
    client(UNBOUND_CLIENT, { isConfidential: true, secret: 'x', userId: -1 }),
  ];
  h.tables.runner_client_bindings = [{ runner_client_id: RUNNER_CLIENT, status: 'active' }];
  h.tables.ApiKey = [];
  h.tables.OauthConsent = [];
}

function consent(extra: Record<string, unknown> = {}) {
  h.tables.OauthConsent.push({
    id: h.tables.OauthConsent.length + 1,
    userId: USER,
    clientId: CLIENT,
    updatedAt: new Date(NOW.getTime() - 5 * DAY),
    scope: Number(TokenScope.UserRead | TokenScope.ModelsRead),
    buzzLimit: null,
    ...extra,
  });
}

/** A live refresh row, as the hub wrote it before the flag (no family, no origin). */
function legacyRefresh(expiresAt: Date, userId = USER, clientId = CLIENT, type = 'Refresh') {
  const token = `civitai_${generateKey(32)}`;
  h.tables.ApiKey.push({
    id: h.tables.ApiKey.length + 100,
    key: generateSecretHash(token),
    name: `${type === 'Refresh' ? 'oauth-refresh' : 'oauth'}:${clientId}`,
    type,
    userId,
    clientId,
    tokenScope: Number(TokenScope.UserRead),
    tokenScopeWide: null,
    expiresAt,
  });
  return token;
}

const authorizeParams = (scope: string, extra: Record<string, string> = {}) => ({
  client_id: CLIENT,
  redirect_uri: REDIRECT,
  response_type: 'code',
  state: 's',
  code_challenge: CHALLENGE,
  code_challenge_method: 'S256',
  scope,
  ...extra,
});

/** Run /authorize (GET, or the consent page's approval POST) and return where it redirected. */
async function authorize(params: Record<string, string>, approve: Record<string, string> | null) {
  const url = new URL('https://auth.civitai.com/api/auth/oauth/authorize');
  const event = (request: Request) =>
    ({
      request,
      url,
      locals: { user: { id: USER } },
      getClientAddress: () => '203.0.113.30',
      cookies: { get: () => undefined, set: () => undefined },
    } as never);
  try {
    if (approve) {
      const body = new URLSearchParams({ ...params, approved: 'true', ...approve });
      await AUTHORIZE_POST(
        event(
          new Request(url, {
            method: 'POST',
            body,
            headers: { origin: 'https://auth.civitai.com' },
          })
        )
      );
    } else {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      await AUTHORIZE_GET(event(new Request(url)));
    }
  } catch (e) {
    const r = e as { status?: number; location?: string };
    if (r.location) return new URL(r.location);
    throw e;
  }
  throw new Error('authorize did not redirect');
}

async function token(body: Record<string, string>, clientId = CLIENT) {
  const res = await TOKEN({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...body }),
    }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function exchangeCode(redirect: URL) {
  const code = redirect.searchParams.get('code');
  expect(code, `expected a code, got ${redirect}`).toBeTruthy();
  return token({
    grant_type: 'authorization_code',
    code: code!,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
}

const refresh = (refreshToken: string, clientId = CLIENT) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken }, clientId);

const row = (raw: unknown) =>
  h.tables.ApiKey.find((k) => k.key === generateSecretHash(String(raw)));

const OFFLINE_COLUMNS = ['mintOrigin', 'refreshFamilyId'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  seed();
  h.flag = false;
  h.strings.clear();
  h.hashes.clear();
  h.events.length = 0;
  h.fetches.length = 0;
  process.env.ORCHESTRATOR_ENDPOINT = 'https://orchestrator.test';
  process.env.ORCHESTRATOR_ACCESS_TOKEN = 'test-orchestrator-token';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      h.fetches.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return new Response(null, { status: 204 });
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BUST_LIMIT = `DELETE /v1/manager/users/${USER}/auth/oauth/${CLIENT}/limits`;
const EXPIRE_TOKENS = `DELETE /v2/consumer/civitai/${USER}/tokens`;
const SECOND = 1000;

describe('flag off: today’s behaviour exactly', () => {
  it('issues a refresh token on an authorization-code grant, offline_access or not, and writes no offline column', async () => {
    consent();
    for (const scope of [
      String(TokenScope.ModelsRead),
      `offline_access ${TokenScope.ModelsRead}`,
    ]) {
      const res = await exchangeCode(await authorize(authorizeParams(scope), null));
      expect(res.status).toBe(200);
      expect(typeof res.body.refresh_token).toBe('string');
      expect(row(res.body.refresh_token)?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    }
    for (const k of h.tables.ApiKey)
      for (const c of OFFLINE_COLUMNS) expect(k).not.toHaveProperty(c);
    for (const c of h.tables.OauthConsent) expect(c).not.toHaveProperty('offlineGrantedAt');
  });

  it('slides a refresh to a fresh 30 days, leaves no tombstone, and a replay revokes nothing', async () => {
    const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY));
    const res = await refresh(old);
    expect(res.status).toBe(200);
    expect(row(res.body.refresh_token)?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    for (const k of h.tables.ApiKey)
      for (const c of OFFLINE_COLUMNS) expect(k).not.toHaveProperty(c);
    expect(h.strings.size).toBe(0);

    const replay = await refresh(old);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(row(res.body.refresh_token)).toBeDefined();
    expect(h.events.map((e) => e.type)).not.toContain('token.reuse_detected');
  });

  it('a remembered consent covers a request with offline_access: no consent screen', async () => {
    consent();
    const redirect = await authorize(
      authorizeParams(`offline_access ${TokenScope.ModelsRead}`),
      null
    );
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  });
});

describe('flag on: the offline grant', () => {
  beforeEach(() => {
    h.flag = true;
  });

  it('issues no refresh token when the client did not ask for offline_access', async () => {
    consent({ offlineGrantedAt: new Date(NOW.getTime() - DAY) });
    const res = await exchangeCode(
      await authorize(authorizeParams(String(TokenScope.ModelsRead)), null)
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe('string');
    expect(res.body).not.toHaveProperty('refresh_token');
    expect(h.tables.ApiKey.map((k) => [k.type, k.mintOrigin])).toEqual([['Access', 'auth_code']]);
  });

  it('sends a remembered consent without the offline grant back to the consent screen', async () => {
    consent();
    const redirect = await authorize(
      authorizeParams(`offline_access ${TokenScope.ModelsRead}`),
      null
    );
    expect(redirect.pathname).toBe('/login/oauth/authorize');
    expect(redirect.searchParams.get('scope')).toBe(`offline_access ${TokenScope.ModelsRead}`);
  });

  it('unticking the line clears an earlier grant, deletes that app’s refresh tokens, and issues none', async () => {
    consent({
      offlineGrantedAt: new Date(NOW.getTime() - DAY),
      offlineBuzzLimit: 200,
      offlineBuzzPeriod: 'week',
    });
    const held = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    const otherClient = legacyRefresh(new Date(NOW.getTime() + 20 * DAY), USER, OTHER_CLIENT);
    const otherUser = legacyRefresh(new Date(NOW.getTime() + 20 * DAY), OTHER_USER, CLIENT);
    const earlierRevoke = new Date(NOW.getTime() - 2 * DAY);
    h.tables.runner_run_authorizations = [
      {
        id: 'live',
        user_id: USER,
        runner_client_id: CLIENT,
        revoked_at: null,
        revoked_reason: null,
      },
      {
        id: 'other-client',
        user_id: USER,
        runner_client_id: OTHER_CLIENT,
        revoked_at: null,
        revoked_reason: null,
      },
      {
        id: 'other-user',
        user_id: OTHER_USER,
        runner_client_id: CLIENT,
        revoked_at: null,
        revoked_reason: null,
      },
      {
        id: 'already',
        user_id: USER,
        runner_client_id: CLIENT,
        revoked_at: earlierRevoke,
        revoked_reason: 'disconnected',
      },
    ];
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`);
    const res = await exchangeCode(await authorize(params, { remember: 'true' }));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('refresh_token');
    expect(h.tables.OauthConsent[0]).toMatchObject({
      offlineGrantedAt: null,
      offlineBuzzLimit: null,
      offlineBuzzPeriod: null,
    });
    expect(row(held)).toBeUndefined();
    expect(row(otherClient)).toBeDefined();
    expect(row(otherUser)).toBeDefined();
    const auths = Object.fromEntries(h.tables.runner_run_authorizations.map((a) => [a.id, a]));
    expect(auths.live).toMatchObject({ revoked_reason: 'offline_declined' });
    expect(auths.live.revoked_at).toBeInstanceOf(Date);
    expect(auths['other-client'].revoked_at).toBeNull();
    expect(auths['other-user'].revoked_at).toBeNull();
    expect(auths.already).toMatchObject({
      revoked_at: earlierRevoke,
      revoked_reason: 'disconnected',
    });
  });

  it('unticking the line when the authorization revoke fails changes nothing, so a retry runs it all', async () => {
    const granted = new Date(NOW.getTime() - DAY);
    consent({ offlineGrantedAt: granted, offlineBuzzLimit: 200, offlineBuzzPeriod: 'week' });
    const held = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    h.tables.runner_run_authorizations = {
      filter() {
        throw new Error('db down');
      },
    } as never;
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`);
    await expect(authorize(params, { remember: 'true' })).rejects.toThrow('db down');
    expect(h.tables.OauthConsent[0]).toMatchObject({
      offlineGrantedAt: granted,
      offlineBuzzLimit: 200,
    });
    expect(row(held)).toBeDefined();
  });

  it('unticking the line with no earlier grant leaves the app’s (grandfathered) refresh tokens alone', async () => {
    consent();
    const held = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`);
    expect((await exchangeCode(await authorize(params, { remember: 'true' }))).status).toBe(200);
    expect(row(held)).toBeDefined();
  });

  it('approving the offline line stores the grant and the chosen cap, and the code earns a refresh token', async () => {
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`, {
      offline_buzz_limit: '500',
    });
    // The user raised the app's proposed 500/day to 2000/week. "Remember" unticked: the grant still
    // needs (and gets) a consent row.
    const res = await exchangeCode(
      await authorize(params, {
        offline: 'true',
        offline_cap_limit: '2000',
        offline_cap_period: 'week',
      })
    );
    expect(res.status).toBe(200);
    expect(typeof res.body.refresh_token).toBe('string');
    expect(h.tables.OauthConsent).toHaveLength(1);
    expect(h.tables.OauthConsent[0]).toMatchObject({
      userId: USER,
      clientId: CLIENT,
      offlineGrantedAt: NOW,
    });
    expect(JSON.parse(String(h.tables.OauthConsent[0].buzzLimit))).toEqual([
      { type: 'sliding', limit: 2000, window: 'day', unit: 7 },
    ]);
    expect(h.fetches).toEqual([BUST_LIMIT]);
    const refreshRow = row(res.body.refresh_token)!;
    expect(refreshRow).toMatchObject({
      mintOrigin: 'auth_code',
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(typeof refreshRow.refreshFamilyId).toBe('string');
    expect(row(res.body.access_token)?.mintOrigin).toBe('auth_code');
  });

  it('re-checks the consent at the code exchange: a disconnect in between means no refresh token', async () => {
    const redirect = await authorize(authorizeParams(`offline_access ${TokenScope.ModelsRead}`), {
      offline: 'true',
    });
    h.tables.OauthConsent = []; // the user disconnects the app before the client redeems the code
    const res = await exchangeCode(redirect);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('refresh_token');
  });

  it('re-approving under an unbroken grant keeps its start time', async () => {
    const earlier = new Date(NOW.getTime() - 3 * DAY);
    consent({ offlineGrantedAt: earlier });
    await authorize(authorizeParams(`offline_access ${TokenScope.ModelsRead}`), {
      offline: 'true',
    });
    expect(h.tables.OauthConsent[0].offlineGrantedAt).toEqual(earlier);
  });

  it('a decline landing between the consent read and the write is not undone: the grant starts now', async () => {
    const earlier = new Date(NOW.getTime() - 3 * DAY);
    consent();
    // The grant's first read sees the old grant; the decline clears it before the upsert runs.
    let stored: Date | null = null;
    let reads = 0;
    Object.defineProperty(h.tables.OauthConsent[0], 'offlineGrantedAt', {
      configurable: true,
      enumerable: true,
      get: () => (reads++ === 0 ? earlier : stored),
      set: (v: Date | null) => (stored = v),
    });
    await grantOffline({
      userId: USER,
      clientId: CLIENT,
      scope: TokenScope.UserRead,
      rememberScope: false,
      proposed: null,
      submitted: null,
      now: NOW,
    });
    expect(stored).toEqual(NOW);
  });

  it('re-consent keeps a custom (multi-budget) cap when the fields are left blank, and busts nothing', async () => {
    const custom = [
      { type: 'sliding', limit: 300, window: 'hour', unit: 1 },
      { type: 'absolute', limit: 9000 },
    ];
    consent({ buzzLimit: custom });
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`, {
      offline_buzz_limit: '500',
    });
    await authorize(params, { offline: 'true', offline_cap_limit: '' });
    expect(h.tables.OauthConsent[0].buzzLimit).toEqual(custom);
    expect(h.tables.OauthConsent[0].offlineGrantedAt).toEqual(NOW);
    expect(h.fetches).toEqual([]);
  });

  it('re-consent keeps a simple cap left as it was, and writes and busts one the user changed', async () => {
    const before = [{ type: 'sliding', limit: 700, window: 'day', unit: 1 }];
    consent({ buzzLimit: before });
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`, {
      offline_buzz_limit: '500',
    });
    // Left at what the screen showed (the current 700/day, not the app's 500).
    await authorize(params, {
      offline: 'true',
      offline_cap_limit: '700',
      offline_cap_period: 'day',
    });
    expect(h.tables.OauthConsent[0].buzzLimit).toEqual(before);
    expect(h.fetches).toEqual([]);

    await authorize(params, {
      offline: 'true',
      offline_cap_limit: '900',
      offline_cap_period: 'day',
    });
    expect(JSON.parse(String(h.tables.OauthConsent[0].buzzLimit))).toEqual([
      { type: 'sliding', limit: 900, window: 'day', unit: 1 },
    ]);
    expect(h.fetches).toEqual([BUST_LIMIT]);
  });

  it("a recipe runner's cap goes to the offline cap columns: buzzLimit is untouched and nothing is busted", async () => {
    const live = [{ type: 'sliding', limit: 50, window: 'day', unit: 1 }];
    consent({ clientId: RUNNER_CLIENT, buzzLimit: live });
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`, {
      client_id: RUNNER_CLIENT,
      offline_buzz_limit: '500',
    });
    const approve = (limit: string, period: string) =>
      authorize(params, { offline: 'true', offline_cap_limit: limit, offline_cap_period: period });

    await approve('2000', 'week');
    expect(h.tables.OauthConsent[0]).toMatchObject({
      offlineGrantedAt: NOW,
      offlineBuzzLimit: 2000,
      offlineBuzzPeriod: 'week',
      buzzLimit: live,
    });
    expect(h.fetches).toEqual([]);

    await approve('900', 'day');
    expect(h.tables.OauthConsent[0]).toMatchObject({
      offlineBuzzLimit: 900,
      offlineBuzzPeriod: 'day',
      buzzLimit: live,
    });

    // Cleared: both null, which refuses every runner mint.
    await approve('', 'day');
    expect(h.tables.OauthConsent[0]).toMatchObject({
      offlineBuzzLimit: null,
      offlineBuzzPeriod: null,
      buzzLimit: live,
    });
    expect(h.fetches).toEqual([]);
  });

  it('a runner-shaped client with no binding keeps the ordinary cap: buzzLimit, busted', async () => {
    consent({ clientId: UNBOUND_CLIENT });
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`, {
      client_id: UNBOUND_CLIENT,
    });
    await authorize(params, {
      offline: 'true',
      offline_cap_limit: '2000',
      offline_cap_period: 'week',
    });
    expect(JSON.parse(String(h.tables.OauthConsent[0].buzzLimit))).toEqual([
      { type: 'sliding', limit: 2000, window: 'day', unit: 7 },
    ]);
    expect(h.tables.OauthConsent[0].offlineBuzzLimit).toBeUndefined();
    expect(h.fetches).toHaveLength(1);
  });

  it('a skip-consent app gets the grant implied once; a later sign-in writes nothing', async () => {
    const params = {
      ...authorizeParams(`offline_access ${TokenScope.ModelsRead}`),
      client_id: SYSTEM_CLIENT,
    };
    expect((await authorize(params, null)).searchParams.get('code')).toBeTruthy();
    expect(h.tables.OauthConsent).toMatchObject([
      { userId: USER, clientId: SYSTEM_CLIENT, offlineGrantedAt: NOW },
    ]);
    const firstRow = { ...h.tables.OauthConsent[0] };

    vi.setSystemTime(new Date(NOW.getTime() + DAY));
    expect((await authorize(params, null)).searchParams.get('code')).toBeTruthy();
    expect(h.tables.OauthConsent).toEqual([firstRow]);
  });

  it('refuses a malformed proposed cap', async () => {
    const redirect = await authorize(
      authorizeParams(`offline_access ${TokenScope.ModelsRead}`, { offline_buzz_limit: '-5' }),
      null
    );
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
  });
});

describe('App Store connect clients: offline access only with an approved declaration', () => {
  // A connect listing pointing at CLIENT, as the main app stores it (listing-offline.ts reads it).
  const listing = (status: string, justifications: unknown, over: Record<string, unknown> = {}) =>
    (h.tables.app_listings = [
      ...(h.tables.app_listings ?? []),
      {
        id: `apl_${(h.tables.app_listings ?? []).length}`,
        kind: 'offsite',
        status,
        connect_client_id: CLIENT,
        connect_scope_justifications: justifications,
        revision_of_id: null,
        ...over,
      },
    ]);
  const ASK = `offline_access ${TokenScope.ModelsRead}`;

  describe('flag on', () => {
    beforeEach(() => {
      h.flag = true;
    });

    it('a declared, approved listing: the approved line earns a refresh token, as before', async () => {
      listing('approved', { offline_access: 'syncs your images nightly' });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.status).toBe(200);
      expect(typeof res.body.refresh_token).toBe('string');
      expect(h.tables.OauthConsent[0]).toMatchObject({ offlineGrantedAt: NOW });
    });

    it('🔴 an UNDECLARED listing: even a posted approval grants nothing, and no refresh token is issued', async () => {
      listing('approved', { ModelsWrite: 'uploads' });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.status).toBe(200);
      expect(typeof res.body.access_token).toBe('string');
      expect(res.body).not.toHaveProperty('refresh_token');
      // No offline grant was written for the approval.
      expect((h.tables.OauthConsent ?? []).every((c) => c.offlineGrantedAt == null)).toBe(true);
      expect(h.tables.ApiKey.map((k) => k.type)).toEqual(['Access']);
    });

    it('🔴 a declaration on a PENDING listing does not count (beside a live undeclared one)', async () => {
      listing('approved', { ModelsWrite: 'uploads' });
      listing('pending', { offline_access: 'syncs your images nightly' }, { revision_of_id: null });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    // A FORMERLY-LIVE listing back in `pending`. Each fixture carries exactly one of the durable
    // "was approved" markers, so each marker is proven on its own.
    it('🔴 approved → a moderator reset to pending (an approved publish request on record): still listed', async () => {
      listing('pending', { ModelsWrite: 'uploads' });
      h.tables.app_listing_publish_requests = [
        { id: 'alpr_first', app_listing_id: 'apl_0', status: 'approved' },
        { id: 'alpr_reset', app_listing_id: 'apl_0', status: 'pending' },
      ];
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('🔴 removed → pending after an asset change (its moderation events on record): still listed', async () => {
      listing('pending', { ModelsWrite: 'uploads' });
      h.tables.app_listing_moderation_events = [
        { id: 'alme_1', app_listing_id: 'apl_0', action: 'owner-unpublish' },
        { id: 'alme_2', app_listing_id: 'apl_0', action: 'owner-republish' },
      ];
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('a FIRST submission still pending (only its pending request, no events) stays unlisted', async () => {
      listing('pending', { ModelsWrite: 'uploads' });
      h.tables.app_listing_publish_requests = [
        { id: 'alpr_first', app_listing_id: 'apl_0', status: 'pending' },
      ];
      h.tables.app_listing_moderation_events = [
        // Another listing's history does not count for this one.
        { id: 'alme_x', app_listing_id: 'apl_other', action: 'delist' },
      ];
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(typeof res.body.refresh_token).toBe('string');
    });

    it.each(['draft', 'pending', 'rejected'])(
      '🔴 a client whose only listing is %s (never live) keeps the unlisted behaviour',
      async (status) => {
        listing(status, { ModelsWrite: 'uploads' });
        const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
        expect(typeof res.body.refresh_token).toBe('string');
        expect(h.tables.OauthConsent[0]).toMatchObject({ offlineGrantedAt: NOW });
      }
    );

    it('🔴 a declaration only on the SHADOW revision (not yet approved) does not count', async () => {
      listing('approved', {});
      listing('draft', { offline_access: 'syncs nightly' }, { revision_of_id: 'apl_0' });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('🔴 a DELISTED app does not fall back to the unlisted rule', async () => {
      listing('removed', { offline_access: 'syncs nightly' });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('🔴 a declaration withdrawn between the approval and the code exchange: no refresh token', async () => {
      listing('approved', { offline_access: 'syncs nightly' });
      const redirect = await authorize(authorizeParams(ASK), { offline: 'true' });
      h.tables.app_listings[0].connect_scope_justifications = {};
      const res = await exchangeCode(redirect);
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('🔴 a declaration withdrawn later: the chain stops sliding and keeps its expiry', async () => {
      listing('approved', { offline_access: 'syncs nightly' });
      const first = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      h.tables.app_listings[0].connect_scope_justifications = {};
      vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY));
      const res = await refresh(String(first.body.refresh_token));
      expect(res.status).toBe(200);
      expect(row(res.body.refresh_token)).toMatchObject({
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
      });
    });

    // Listings that cannot be read: a getter that throws on the table the hub reads.
    const breakListings = () =>
      Object.defineProperty(h.tables, 'app_listings', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('db down');
        },
      });

    it('🔴 fail-closed at the CODE EXCHANGE: a read failure there means no refresh token', async () => {
      listing('approved', { offline_access: 'syncs nightly' });
      const redirect = await authorize(authorizeParams(ASK), { offline: 'true' });
      breakListings();
      const res = await exchangeCode(redirect);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('refresh_token');
    });

    it('🔴 fail-closed at REFRESH: a read failure stops the chain sliding', async () => {
      listing('approved', { offline_access: 'syncs nightly' });
      const first = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      breakListings();
      vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY));
      const res = await refresh(String(first.body.refresh_token));
      expect(res.status).toBe(200);
      expect(row(res.body.refresh_token)).toMatchObject({
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
      });
    });

    it('🔴 an UNTICK is honoured even when the listing read fails at the POST', async () => {
      // The user held the grant from an earlier visit, and a refresh token with it.
      consent({ offlineGrantedAt: new Date(NOW.getTime() - DAY) });
      legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
      breakListings();
      await authorize(authorizeParams(ASK), { offline: 'false' });
      expect(h.tables.OauthConsent[0].offlineGrantedAt).toBeNull();
      expect(h.tables.ApiKey.filter((k) => k.type === 'Refresh' && k.clientId === CLIENT)).toEqual(
        []
      );
    });

    it('a client no listing points at is unchanged (another client listed does not matter)', async () => {
      listing('approved', {}, { connect_client_id: OTHER_CLIENT });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(typeof res.body.refresh_token).toBe('string');
    });
  });

  describe('flag off', () => {
    it('an undeclared listed client still gets a refresh token, exactly as before', async () => {
      listing('approved', { ModelsWrite: 'uploads' });
      const res = await exchangeCode(await authorize(authorizeParams(ASK), { offline: 'true' }));
      expect(typeof res.body.refresh_token).toBe('string');
    });
  });
});

describe('flag on: refresh expiry', () => {
  beforeEach(() => {
    h.flag = true;
  });

  it('a chain under an offline grant slides to a fresh 30 days and keeps its family', async () => {
    const first = await exchangeCode(
      await authorize(authorizeParams(`offline_access ${TokenScope.ModelsRead}`), {
        offline: 'true',
      })
    );
    const family = row(first.body.refresh_token)!.refreshFamilyId;
    vi.setSystemTime(new Date(NOW.getTime() + 10 * DAY));
    const res = await refresh(String(first.body.refresh_token));
    expect(res.status).toBe(200);
    expect(row(res.body.refresh_token)).toMatchObject({
      refreshFamilyId: family,
      mintOrigin: 'auth_code',
      expiresAt: new Date(NOW.getTime() + 40 * DAY),
    });
    expect(row(res.body.access_token)?.mintOrigin).toBe('refresh');
  });

  it('a grandfathered chain (no offline grant) rotates but keeps its original expiry, then lapses', async () => {
    consent(); // a consent, but no offline grant
    const original = new Date(NOW.getTime() + 3 * DAY + 1234);
    const old = legacyRefresh(original);
    const res = await refresh(old);
    expect(res.status).toBe(200);
    const next = row(res.body.refresh_token)!;
    expect(next.expiresAt).toEqual(original);
    expect(typeof next.refreshFamilyId).toBe('string');
    expect(next.mintOrigin).toBeNull();

    vi.setSystemTime(new Date(original.getTime() + 1));
    const lapsed = await refresh(String(res.body.refresh_token));
    expect(lapsed.status).toBe(400);
    expect(lapsed.body.error).toBe('invalid_grant');
  });

  it('a device-flow client’s chain keeps sliding without a consent', async () => {
    const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY), USER, DEVICE_CLIENT);
    row(old)!.mintOrigin = 'device_code';
    row(old)!.refreshFamilyId = 'fam-device';
    const res = await refresh(old, DEVICE_CLIENT);
    expect(row(res.body.refresh_token)).toMatchObject({
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      refreshFamilyId: 'fam-device',
      mintOrigin: 'device_code',
    });
  });

  it('a pre-flag device chain (no recorded origin) keeps sliding: read off the client’s device grant', async () => {
    const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY), USER, DEVICE_CLIENT);
    const res = await refresh(old, DEVICE_CLIENT);
    expect(res.status).toBe(200);
    expect(row(res.body.refresh_token)?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  describe('a client holding both the authorization-code and device-code grants', () => {
    it('does not slide its auth_code chain without the offline grant', async () => {
      const original = new Date(NOW.getTime() + 3 * DAY + 2468);
      const old = legacyRefresh(original, USER, DUAL_CLIENT);
      row(old)!.mintOrigin = 'auth_code';
      const res = await refresh(old, DUAL_CLIENT);
      expect(res.status).toBe(200);
      expect(row(res.body.refresh_token)?.expiresAt).toEqual(original);
    });

    it('slides its device_code chain', async () => {
      const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY + 2468), USER, DUAL_CLIENT);
      row(old)!.mintOrigin = 'device_code';
      const res = await refresh(old, DUAL_CLIENT);
      expect(row(res.body.refresh_token)?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    });

    it('slides its pre-flag (null-origin) chain', async () => {
      const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY + 2468), USER, DUAL_CLIENT);
      const res = await refresh(old, DUAL_CLIENT);
      expect(row(res.body.refresh_token)?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY));
    });
  });
});

describe('flag on: refresh reuse detection', () => {
  beforeEach(() => {
    h.flag = true;
  });

  it('replaying a rotated token revokes its family and the user’s access tokens for that client, and nothing else', async () => {
    consent({ offlineGrantedAt: NOW });
    const t1 = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    const otherUser = legacyRefresh(new Date(NOW.getTime() + 20 * DAY), OTHER_USER, CLIENT);
    const otherClient = legacyRefresh(new Date(NOW.getTime() + 20 * DAY), USER, OTHER_CLIENT);
    // Access tokens that must survive: another user's on this client, this user's on another client.
    const end = new Date(NOW.getTime() + DAY);
    const otherUserAccess = legacyRefresh(end, OTHER_USER, CLIENT, 'Access');
    const otherClientAccess = legacyRefresh(end, USER, OTHER_CLIENT, 'Access');
    const rotated = await refresh(t1);
    expect(rotated.status).toBe(200);
    const t2 = String(rotated.body.refresh_token);
    const a2 = String(rotated.body.access_token);

    // One tombstone, for t1, bounded by REFRESH_TOMBSTONE_TTL (7 days < t1's 20 days left).
    expect([...h.strings.values()]).toEqual([
      {
        value: {
          familyId: row(t2)!.refreshFamilyId,
          userId: USER,
          clientId: CLIENT,
          rotatedAt: NOW.getTime(),
        },
        ex: 7 * 86_400,
      },
    ]);

    // Past the 60 s reuse grace.
    vi.setSystemTime(new Date(NOW.getTime() + 90 * SECOND));
    const replay = await refresh(t1);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(row(t2)).toBeUndefined();
    expect(row(a2)).toBeUndefined();
    expect(row(otherUser)).toBeDefined();
    expect(row(otherClient)).toBeDefined();
    expect(row(otherUserAccess)).toBeDefined();
    expect(row(otherClientAccess)).toBeDefined();
    expect(h.events).toContainEqual({
      type: 'token.reuse_detected',
      userId: USER,
      clientId: CLIENT,
    });
    expect(h.fetches).toEqual([EXPIRE_TOKENS]);

    // The thief's (or the client's) newer token is dead too.
    expect((await refresh(t2)).status).toBe(400);
  });

  it('replaying a rotated token inside the 60 s grace is plain invalid_grant and revokes nothing', async () => {
    consent({ offlineGrantedAt: NOW });
    const t1 = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    const rotated = await refresh(t1);
    const t2 = String(rotated.body.refresh_token);
    vi.setSystemTime(new Date(NOW.getTime() + 30 * SECOND));
    const replay = await refresh(t1);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(row(t2)).toBeDefined();
    expect(row(rotated.body.access_token)).toBeDefined();
    expect(h.events.map((e) => e.type)).not.toContain('token.reuse_detected');
    expect(h.fetches).toEqual([]);
  });

  it('a tombstone never outlives the rotated token: one with 2 days left lasts 2 days', async () => {
    consent({ offlineGrantedAt: NOW });
    const t1 = legacyRefresh(new Date(NOW.getTime() + 2 * DAY));
    expect((await refresh(t1)).status).toBe(200);
    expect([...h.strings.values()].map((v) => v.ex)).toEqual([2 * 86_400]);
  });

  it('an unknown token (no tombstone) is plain invalid_grant and revokes nothing (positive control for the counts above)', async () => {
    consent({ offlineGrantedAt: NOW });
    const live = legacyRefresh(new Date(NOW.getTime() + 20 * DAY));
    const res = await refresh(`civitai_${generateKey(32)}`);
    expect(res.status).toBe(400);
    expect(row(live)).toBeDefined();
    expect(h.events.map((e) => e.type)).not.toContain('token.reuse_detected');
  });
});

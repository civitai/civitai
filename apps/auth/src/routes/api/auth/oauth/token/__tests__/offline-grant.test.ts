import { createHash } from 'crypto';
import { unpack } from 'msgpackr';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
vi.mock('$lib/server/oauth/rate-limit', () => ({ checkOAuthRateLimit: vi.fn(async () => true) }));
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

const USER = 41;
const OTHER_USER = 42;
const CLIENT = 'offline-app';
const OTHER_CLIENT = 'other-app';
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
  h.tables.OauthClient = [CLIENT, OTHER_CLIENT].map((id) => ({
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
  }));
  h.tables.ApiKey = [];
  h.tables.OauthConsent = [];
}

function consent(extra: Record<string, unknown> = {}) {
  h.tables.OauthConsent.push({
    id: h.tables.OauthConsent.length + 1,
    userId: USER,
    clientId: CLIENT,
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

async function token(body: Record<string, string>) {
  const res = await TOKEN({
    request: new Request('https://auth.civitai.com/api/auth/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT, ...body }),
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

const refresh = (refreshToken: string) =>
  token({ grant_type: 'refresh_token', refresh_token: refreshToken });

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
});
afterEach(() => vi.useRealTimers());

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

  it('issues no refresh token when the user unticks the offline line, and clears an earlier grant', async () => {
    consent({ offlineGrantedAt: new Date(NOW.getTime() - DAY) });
    const params = authorizeParams(`offline_access ${TokenScope.ModelsRead}`);
    const res = await exchangeCode(await authorize(params, { remember: 'true' }));
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('refresh_token');
    expect(h.tables.OauthConsent[0].offlineGrantedAt).toBeNull();
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

  it('refuses a malformed proposed cap', async () => {
    const redirect = await authorize(
      authorizeParams(`offline_access ${TokenScope.ModelsRead}`, { offline_buzz_limit: '-5' }),
      null
    );
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
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

  it('a device-flow chain keeps sliding without a consent', async () => {
    const old = legacyRefresh(new Date(NOW.getTime() + 3 * DAY));
    row(old)!.mintOrigin = 'device_code';
    row(old)!.refreshFamilyId = 'fam-device';
    const res = await refresh(old);
    expect(row(res.body.refresh_token)).toMatchObject({
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
      refreshFamilyId: 'fam-device',
      mintOrigin: 'device_code',
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
        value: { familyId: row(t2)!.refreshFamilyId, userId: USER, clientId: CLIENT },
        ex: 7 * 86_400,
      },
    ]);

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

    // The thief's (or the client's) newer token is dead too.
    expect((await refresh(t2)).status).toBe(400);
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type * as RedisModule from '$lib/server/redis';
import type * as RequestModule from '$lib/server/auth/request';

// The block token exchange (token route → block-exchange.ts), end to end through the token route. Each
// refusal starts from the request the "issues" test proves is accepted and changes ONE thing, so a refusal
// test fails (status 200, or a different reason) if the guard it names is removed. Expected values are
// literals, never read back from the code under test. The minted token is verified against the hub's own
// JWKS route with the checks the registry adapter applies (`auth.jwt.ts` → `createAccessTokenJwtVerifier`).

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync, createHash, createPublicKey } = await import('node:crypto');
  const rsa = () =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  const site = rsa();
  const forger = rsa();
  const hub = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const kidOf = (pem: string) => {
    const jwk = createPublicKey(pem).export({ format: 'jwk' }) as { n?: string };
    return createHash('sha256')
      .update(jwk.n ?? '')
      .digest('hex')
      .slice(0, 32);
  };
  process.env.NEXTAUTH_SECRET = 'block-exchange-test-secret';
  process.env.AUTH_JWT_PRIVATE_KEY = hub.privateKey;
  process.env.AUTH_JWT_PUBLIC_KEY = hub.publicKey;
  process.env.AUTH_JWT_KID = 'hub-test-kid';
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.CIVITAI_MODERATION_USER_ID = '999';
  return {
    site,
    forger,
    siteKid: kidOf(site.publicKey),
    forgerKid: kidOf(forger.publicKey),
    hubPublicKey: hub.publicKey,
    tables: {} as Record<string, Record<string, unknown>[]>,
    cache: new Map<string, string>(),
    cacheEx: new Map<string, number | undefined>(),
    replayHang: false,
    // The SET is applied at once but its reply never comes (it landed; the caller timed out).
    replayApplyThenHang: false,
    // The SET is held until the test lands it (it lands only after the caller timed out).
    replayDeferred: null as (() => void)[] | null,
    replaySetCalled: false,
    dbThrowsOn: null as string | null,
    // Runs a script on the replay store's state in real Lua (set in beforeEach from the harness).
    luaEval: null as
      | null
      | ((script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>),
    sys: new Map<string, { value: string; ex: number }>(),
    sysSetThrows: false,
    redisNull: false,
    rate: new Map<string, number>(),
    clientIp: '203.0.113.7' as string | null,
    events: [] as Record<string, unknown>[],
    logs: [] as Record<string, unknown>[],
  };
});

type Row = Record<string, unknown>;

function matches(row: Row, [column, op, value]: [string, string, unknown]): boolean {
  const actual = row[column.includes('.') ? column.slice(column.indexOf('.') + 1) : column];
  const t = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  switch (op) {
    case '=':
      return t(actual) === t(value);
    case 'is':
      return actual === value;
    case 'is not':
      return actual !== value;
    case '>':
      return actual instanceof Date && value instanceof Date && actual > value;
    case 'in':
      return (value as unknown[]).includes(actual);
    default:
      throw new Error(`the db fake does not implement operator "${op}"`);
  }
}

// Read-only: the exchange writes no row, and a write would throw here.
vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const where: [string, string, unknown][] = [];
      const run = () => (h.tables[table] ?? []).filter((r) => where.every((w) => matches(r, w)));
      const qb: Record<string, unknown> = {
        select: () => qb,
        innerJoin: () => qb,
        orderBy: () => qb,
        limit: () => qb,
        where: (column: string, op: string, value: unknown) => {
          if (typeof column === 'string') where.push([column, op, value]);
          return qb;
        },
        executeTakeFirst: async () => {
          if (h.dbThrowsOn === table) throw new Error('db fake: connection lost');
          return run()[0];
        },
        execute: async () => {
          if (h.dbThrowsOn === table) throw new Error('db fake: connection lost');
          return run();
        },
      };
      return qb;
    },
  },
}));

vi.mock('$lib/server/redis', async (orig) => ({
  ...(await orig<typeof RedisModule>()),
  getRedis: () =>
    h.redisNull
      ? null
      : {
          async set(key: string, value: string, opts?: { NX?: boolean; EX?: number }) {
            h.replaySetCalled = true;
            const apply = () => {
              if (opts?.NX && h.cache.has(key)) return null;
              h.cache.set(key, value);
              h.cacheEx.set(key, opts?.EX);
              return 'OK';
            };
            if (h.replayHang) return new Promise<never>(() => undefined);
            if (h.replayApplyThenHang) {
              apply();
              return new Promise<never>(() => undefined);
            }
            const deferred = h.replayDeferred;
            if (deferred) {
              return new Promise<string | null>((resolve) => {
                deferred.push(() => resolve(apply()));
              });
            }
            return apply();
          },
          async get(key: string) {
            return h.cache.get(key) ?? null;
          },
          async del(key: string) {
            return h.cache.delete(key) ? 1 : 0;
          },
          async eval(script: string, options: { keys: string[]; arguments: string[] }) {
            return h.luaEval!(script, options);
          },
        },
  getSysRedis: () => ({
    isReady: true,
    async set(key: string, value: string, opts: { EX: number }) {
      if (h.sysSetThrows) throw new Error('sys redis down');
      h.sys.set(key, { value, ex: opts.EX });
      return 'OK';
    },
    async get(key: string) {
      return h.sys.get(key)?.value ?? null;
    },
  }),
}));

vi.mock('$lib/server/auth/rate-limit', () => ({
  async checkRateLimit(bucket: string, id: string | null | undefined, limit: number) {
    if (!id) return true;
    const key = `${bucket}:${id}`;
    const n = (h.rate.get(key) ?? 0) + 1;
    h.rate.set(key, n);
    return n <= limit;
  },
  async isRateLimited() {
    return false;
  },
}));

vi.mock('$lib/server/axiom', () => ({
  logToAxiom: async (data: Record<string, unknown>) => {
    h.logs.push(data);
  },
  logAxiomError: async () => undefined,
}));
vi.mock('$lib/server/oauth/audit-log', () => ({
  logOAuthEvent: (e: Record<string, unknown>) => {
    h.events.push(e);
  },
}));
vi.mock('$lib/server/auth/request', async (orig) => ({
  ...(await orig<typeof RequestModule>()),
  getClientIp: () => h.clientIp,
}));

import {
  SignJWT,
  importPKCS8,
  jwtVerify,
  createLocalJWKSet,
  decodeProtectedHeader,
  type JSONWebKeySet,
} from 'jose';
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST as tokenPOST } from '../../../../routes/api/auth/oauth/token/+server';
import { POST as introspectPOST } from '../../../../routes/api/auth/oauth/introspect/+server';
import { GET as jwksGET } from '../../../../routes/.well-known/jwks.json/+server';
import { WorkerTokenExchangeGrant } from '../worker-grant';
import { invalidateRoleCache } from '../access';
import { MATURE_BROWSING_LEVELS, parseBlockExchangeCallers } from '../block-exchange';
import { getSigner } from '../user-exchange';
import { createLuaRedis } from '../../../../test/lua-sys-redis';
import {
  BLOCK_TOKEN_AUDIENCE,
  BLOCK_TOKEN_ISSUER,
  BLOCK_USER_SUB_RE,
  CLOCK_TOLERANCE_SECONDS,
  MAX_AGE_SECONDS,
} from '../block-token-verify';

const NOW = 1_800_000_000; // a fixed second, so lifetimes are exact
const ISSUER = 'https://auth.test';
const RESOURCE = 'https://apps.registry.test';
const APP = 'appblk-notes';
const RELAY = 'relay-app-data';
const OTHER_RELAY = 'relay-other';
const INTROSPECTOR = 'origin-introspector';
const SECRET = 'client-secret-value';
const USER_ID = 42;
const BLOCK_TOKEN_TYPE = 'urn:civitai:token-type:block-token';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

function client(id: string, over: Row = {}): Row {
  return {
    id,
    secret: generateSecretHash(SECRET),
    isConfidential: true,
    tokenRateLimit: null,
    userId: 1,
    accessMode: 'open',
    allowedScopes: TokenScope.AppDataRead | TokenScope.AppsRead | TokenScope.UserRead,
    ...over,
  };
}

function registry(over: Row = {}) {
  return JSON.stringify([
    {
      resource: RESOURCE,
      scopes: ['AppsRead', 'AppDataRead'],
      apps: [APP],
      relays: [RELAY, OTHER_RELAY],
      introspectors: [],
      ...over,
    },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  h.tables = {
    OauthClient: [client(APP), client(RELAY), client(OTHER_RELAY)],
    User: [{ id: USER_ID, username: 'alice', deletedAt: null, bannedAt: null, muted: false }],
    UserRole: [],
    app_blocks: [{ id: 'apb_01notes', app_id: APP, status: 'approved' }],
  };
  h.cache.clear();
  h.cacheEx.clear();
  h.replayHang = false;
  h.replayApplyThenHang = false;
  h.replayDeferred = null;
  // The release's compare-and-delete runs as real Lua over the fake store's current value of its key.
  h.luaEval = async (script, options) => {
    const lua = createLuaRedis(Date.now());
    const [key] = options.keys;
    const before = h.cache.get(key);
    if (before !== undefined) lua.setString(key, before);
    const result = await lua.eval(script, options);
    if (before !== undefined && lua.string(key) === undefined) h.cache.delete(key);
    return result;
  };
  h.replaySetCalled = false;
  h.dbThrowsOn = null;
  h.sys.clear();
  h.sysSetThrows = false;
  h.redisNull = false;
  h.rate.clear();
  h.clientIp = '203.0.113.7';
  h.events = [];
  h.logs = [];
  invalidateRoleCache();
  process.env.AUTH_JWT_ISSUER = ISSUER;
  process.env.OAUTH_EXCHANGE_RESOURCES = registry();
  process.env.OAUTH_BLOCK_EXCHANGE_CALLERS = RELAY;
  process.env.BLOCK_TOKEN_PUBLIC_KEY = h.site.publicKey;
  delete process.env.BLOCK_TOKEN_PUBLIC_KEY_NEXT;
});

afterEach(() => {
  vi.useRealTimers();
});

let jtiSeq = 0;

/** A block token as the site signs it: RS256, `typ: JWT`, the site's kid, for USER_ID on APP. */
async function blockToken(
  over: Row = {},
  opts: { key?: string; kid?: string } = {}
): Promise<string> {
  const claims: Row = {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${USER_ID}`,
    iat: NOW,
    exp: NOW + 900,
    jti: `blk-${++jtiSeq}`,
    blockId: 'notes',
    appId: APP,
    appBlockId: 'apb_01notes',
    blockInstanceId: 'inst-1',
    ctx: {},
    scopes: ['apps:storage', 'user:read:self'],
    maxBrowsingLevel: 31, // minted on a mature-capable host: every rating
    ...over,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? h.siteKid })
    .sign(await importPKCS8(opts.key ?? h.site.privateKey, 'RS256'));
}

const basic = (id: string, secret = SECRET) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function exchange(
  subject: string,
  opts: { caller?: string; secret?: string; params?: Row } = {}
) {
  const form = new URLSearchParams();
  const params: Row = {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subject,
    subject_token_type: BLOCK_TOKEN_TYPE,
    resource: RESOURCE,
    ...opts.params,
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.append(k, String(v));
  const request = new Request('https://auth.test/api/auth/oauth/token', {
    method: 'POST',
    body: form,
    headers: { authorization: basic(opts.caller ?? RELAY, opts.secret) },
  });
  const res = await tokenPOST({ request } as never);
  return { status: res.status, body: (await res.json()) as Row };
}

/** Verify a minted token the way the registry adapter does, against the hub's published JWKS. */
async function verifyLikeTheAdapter(token: string) {
  const jwks = (await (await jwksGET({} as never)).json()) as JSONWebKeySet;
  return jwtVerify(token, createLocalJWKSet(jwks), {
    algorithms: ['ES256'],
    issuer: ISSUER,
    audience: RESOURCE,
    typ: 'at+jwt',
    clockTolerance: 0,
    currentDate: new Date(NOW * 1000),
    requiredClaims: ['exp', 'iat', 'jti', 'sub', 'aud', 'client_id'],
  });
}

const refusals = () => h.events.filter((e) => e.type === 'block_exchange.refused');
const lastReason = () =>
  (refusals().at(-1)?.metadata as Row | undefined)?.reason as string | undefined;
const issued = () => h.events.filter((e) => e.type === 'block_exchange.issued');

describe('block token exchange — dark by default (empty caller allowlist)', () => {
  it('refuses every request when OAUTH_BLOCK_EXCHANGE_CALLERS is unset, and mints nothing', async () => {
    delete process.env.OAUTH_BLOCK_EXCHANGE_CALLERS;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'unauthorized_client',
      error_description: 'This client may not exchange this token for this resource',
    });
    expect(lastReason()).toBe('caller allowlist empty');
    expect(issued()).toEqual([]);
    expect(h.sys.size).toBe(0);
  });

  it('refuses when the list is blank', async () => {
    process.env.OAUTH_BLOCK_EXCHANGE_CALLERS = ' , ';
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller allowlist empty');
  });

  it('refuses everyone when one listed id is malformed (the whole list is dropped)', async () => {
    process.env.OAUTH_BLOCK_EXCHANGE_CALLERS = `${RELAY}, bad/id`;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller allowlist invalid');
    expect(issued()).toEqual([]);
  });

  it('parses the list literally', () => {
    expect(parseBlockExchangeCallers(undefined)).toEqual({ callers: new Set() });
    expect(parseBlockExchangeCallers('a-1, b.2\nc_3')).toEqual({
      callers: new Set(['a-1', 'b.2', 'c_3']),
    });
    expect(parseBlockExchangeCallers('ok bad/id')).toEqual({
      error: 'OAUTH_BLOCK_EXCHANGE_CALLERS has an invalid client id',
    });
  });

  // WIRING-LEVEL: the limiter is the fake above, so this proves which bucket is charged and that a refusal
  // past it is not audited, not the real limiter's window or Redis behaviour.
  it('charges unauthenticated refusals to the per-IP bucket, and stops auditing past it (wiring-level)', async () => {
    delete process.env.OAUTH_BLOCK_EXCHANGE_CALLERS;
    const token = await blockToken();
    for (let i = 0; i < 120; i++) expect((await exchange(token)).status).toBe(400);
    const res = await exchange(token);
    expect(res.status).toBe(429);
    expect(refusals()).toHaveLength(120);
  });
});

describe('block token exchange — the caller', () => {
  it('refuses an authenticated relay that is not on the allowlist', async () => {
    const res = await exchange(await blockToken(), { caller: OTHER_RELAY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller not allowlisted');
    expect(issued()).toEqual([]);
  });

  it('refuses a caller with the wrong secret', async () => {
    const res = await exchange(await blockToken(), { secret: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(lastReason()).toBe('client authentication failed');
  });

  // WIRING-LEVEL, like the per-IP test: the limiter is a fake.
  it('charges the caller limit before the allowlist; past it, 429 with no audit event (wiring-level)', async () => {
    // A staff-set limit of 3 (honoured for a system-owned client) instead of the default 600.
    const other = h.tables.OauthClient.find((c) => c.id === OTHER_RELAY)!;
    other.userId = -1;
    other.tokenRateLimit = 3;
    const token = await blockToken();
    for (let i = 0; i < 3; i++) {
      expect((await exchange(token, { caller: OTHER_RELAY })).status).toBe(400);
      expect(lastReason()).toBe('caller not allowlisted');
    }
    const res = await exchange(token, { caller: OTHER_RELAY });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(refusals()).toHaveLength(3);
  });

  it('refuses a disabled caller', async () => {
    h.tables.OauthClient.find((c) => c.id === RELAY)!.accessMode = 'disabled';
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller disabled');
    expect(issued()).toEqual([]);
  });

  it('refuses a resource that may not receive AppDataRead', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ scopes: ['AppsRead'] });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
    expect(lastReason()).toBe('resource does not receive AppDataRead');
    expect(issued()).toEqual([]);
  });

  it('refuses an allowlisted caller that is not a relay of the resource', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ relays: [OTHER_RELAY] });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller not a relay of resource');
  });

  it('never reaches the worker grant', async () => {
    const spy = vi.spyOn(WorkerTokenExchangeGrant.prototype, 'handle');
    const res = await exchange(await blockToken());
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('block token exchange — what it issues', () => {
  it('issues an at+jwt the adapter accepts: AppDataRead only, the relay in act, 15 minutes, no refresh', async () => {
    const res = await exchange(await blockToken());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'access_token',
      'expires_in',
      'issued_token_type',
      'scope',
      'token_type',
    ]);
    expect(res.body).toMatchObject({
      scope: 'AppDataRead',
      expires_in: 900,
      token_type: 'Bearer',
      issued_token_type: ACCESS_TOKEN_TYPE,
    });

    const token = String(res.body.access_token);
    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'ES256',
      kid: 'hub-test-kid',
      typ: 'at+jwt',
    });
    const { payload } = await verifyLikeTheAdapter(token);
    expect(Object.keys(payload).sort()).toEqual([
      'act',
      'aud',
      'client_id',
      'exp',
      'iat',
      'iss',
      'jti',
      'scope',
      'sub',
    ]);
    expect(payload).toMatchObject({
      iss: 'https://auth.test',
      aud: 'https://apps.registry.test',
      sub: '42',
      client_id: 'appblk-notes',
      scope: 'AppDataRead',
      act: { sub: 'relay-app-data' },
      iat: NOW,
      exp: NOW + 900,
    });

    // The hub's record of it, as every exchanged token has, under its own kind.
    const record = JSON.parse(h.sys.get(`oauth:xchg:${payload.jti}`)!.value);
    expect(record).toEqual({
      kind: 'block-exchange',
      userId: 42,
      clientId: 'appblk-notes',
      actor: 'relay-app-data',
      resource: 'https://apps.registry.test',
      scopeBits: 4294967296,
      exp: NOW + 900,
      blockJti: expect.stringMatching(/^blk-/),
    });

    expect(issued()).toHaveLength(1);
    expect(issued()[0]).toMatchObject({
      userId: 42,
      clientId: 'appblk-notes',
      metadata: { caller: 'relay-app-data', resource: RESOURCE, jti: payload.jti },
    });
  });

  it('issues AppDataRead only, whatever else the block token carries', async () => {
    const res = await exchange(
      await blockToken({
        scopes: ['apps:storage', 'apps:storage:publish', 'ai:write:budgeted', 'buzz:read:self'],
      })
    );
    expect(res.status).toBe(200);
    const { payload } = await verifyLikeTheAdapter(String(res.body.access_token));
    expect(payload.scope).toBe('AppDataRead');
  });

  it('never outlives the block token it came from', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 600, exp: NOW + 300 }));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
    const { payload } = await verifyLikeTheAdapter(String(res.body.access_token));
    expect(payload.exp).toBe(NOW + 300);
  });

  it('caps the token at 15 minutes even when the block token claims to live longer', async () => {
    // A block token whose exp overshoots the cap (a signer bug the age check alone would not catch).
    const res = await exchange(await blockToken({ iat: NOW, exp: NOW + 3600 }));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(900);
    const { payload } = await verifyLikeTheAdapter(String(res.body.access_token));
    expect(payload.exp).toBe(NOW + 900);
  });

  it('accepts scope=AppDataRead and refuses any other requested scope', async () => {
    const ok = await exchange(await blockToken(), { params: { scope: 'AppDataRead' } });
    expect(ok.status).toBe(200);
    const wider = await exchange(await blockToken(), {
      params: { scope: 'AppDataRead UserRead' },
    });
    expect(wider.status).toBe(400);
    expect(wider.body.error).toBe('invalid_scope');
    expect(lastReason()).toBe('scope must be AppDataRead');
    expect(issued()).toHaveLength(1);
  });
});

describe('block token exchange — the block token', () => {
  it('refuses a block token without apps:storage', async () => {
    const res = await exchange(
      await blockToken({ scopes: ['user:read:self', 'apps:storage:read'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token has no apps:storage scope');
    expect(issued()).toEqual([]);
  });

  it('refuses an expired block token', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 1000, exp: NOW - 60 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token signature or claims');
  });

  it('refuses a block token signed by another key under the site kid (forged)', async () => {
    const res = await exchange(await blockToken({}, { key: h.forger.privateKey }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token signature or claims');
    expect(issued()).toEqual([]);
  });

  it('refuses a block token whose kid the hub does not hold', async () => {
    const res = await exchange(
      await blockToken({}, { key: h.forger.privateKey, kid: h.forgerKid })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token unknown key');
  });

  it('refuses a block token for another audience', async () => {
    const res = await exchange(await blockToken({ aud: 'civitai-other' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token signature or claims');
  });

  it('refuses an anonymous viewer', async () => {
    const res = await exchange(await blockToken({ sub: 'anon' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token anonymous');
  });

  it('refuses a review run-for-real token', async () => {
    const res = await exchange(await blockToken({ reviewRunForReal: true }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token review token');
    expect(issued()).toEqual([]);
  });

  it('refuses a block token that is past its exp but inside the verifier skew', async () => {
    // jose accepts it (30 s clock tolerance); the exchange would mint a token already expired.
    const res = await exchange(await blockToken({ iat: NOW - 600, exp: NOW - 10 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token expiring');
    expect(issued()).toEqual([]);
  });

  it('refuses every token when the public-key variable holds a non-RSA (EC) public key', async () => {
    process.env.BLOCK_TOKEN_PUBLIC_KEY = h.hubPublicKey;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(lastReason()).toBe('block token keys misconfigured');
    expect(h.logs.filter((l) => l.name === 'block-token-public-key-invalid')).toEqual([
      {
        type: 'error',
        name: 'block-token-public-key-invalid',
        message: 'BLOCK_TOKEN_PUBLIC_KEY is not an RSA public key',
      },
    ]);
  });

  it('refuses dev and private-run tokens', async () => {
    const dev = await exchange(await blockToken({ dev: true }));
    expect(dev.status).toBe(400);
    expect(dev.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token dev token');
    const privateRun = await exchange(
      await blockToken({ privateRun: true, privateRunAudience: 'owner' })
    );
    expect(privateRun.status).toBe(400);
    expect(privateRun.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token private run');
    expect(issued()).toEqual([]);
  });

  it('refuses a block token older than 15 minutes even if its exp is later', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 931, exp: NOW + 600 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token too old');
  });

  it('refuses every token when the hub holds no block-token key', async () => {
    delete process.env.BLOCK_TOKEN_PUBLIC_KEY;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(lastReason()).toBe('block token keys not configured');
  });

  it('refuses every token, and says so once, when the public-key variable holds a private key', async () => {
    process.env.BLOCK_TOKEN_PUBLIC_KEY = h.site.privateKey;
    const first = await exchange(await blockToken());
    const second = await exchange(await blockToken());
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(first.body.error).toBe('server_error');
    expect(second.body.error).toBe('server_error');
    expect(lastReason()).toBe('block token keys misconfigured');
    expect(h.logs.filter((l) => l.name === 'block-token-public-key-invalid')).toEqual([
      {
        type: 'error',
        name: 'block-token-public-key-invalid',
        message: 'BLOCK_TOKEN_PUBLIC_KEY is a private key',
      },
    ]);
  });

  it('refuses every token when one key value does not parse, rather than skipping it', async () => {
    process.env.BLOCK_TOKEN_PUBLIC_KEY = 'not a pem (test 1)';
    process.env.BLOCK_TOKEN_PUBLIC_KEY_NEXT = h.site.publicKey;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(lastReason()).toBe('block token keys misconfigured');
    expect(h.logs.filter((l) => l.name === 'block-token-public-key-invalid')).toEqual([
      {
        type: 'error',
        name: 'block-token-public-key-invalid',
        message: 'BLOCK_TOKEN_PUBLIC_KEY does not parse as a public key',
      },
    ]);
  });
});

/**
 * Run one exchange whose replay claim does not answer in time (whatever the fake replay store is set to do
 * with the SET), and return its answer: wait for the SET to be sent, then let the 2 s timeout pass.
 */
async function exchangeWithReplayTimeout(token: string) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW * 1000);
  h.replaySetCalled = false;
  const pending = exchange(token);
  // Real async work (signature checks) runs before the claim; wait for the claim itself.
  for (let i = 0; i < 500 && !h.replaySetCalled; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(h.replaySetCalled).toBe(true);
  await vi.advanceTimersByTimeAsync(2001);
  return pending;
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('block token exchange — one exchange per block token', () => {
  it('claims the block token until a minute past its exp', async () => {
    const res = await exchange(await blockToken({ iat: NOW, exp: NOW + 900 }));
    expect(res.status).toBe(200);
    // exp - now + 60: a replay is refused for as long as the block token could verify (30 s skew included).
    expect([...h.cacheEx.values()]).toEqual([960]);
  });

  it('answers 503 when the replay store does not answer in 2 s, and the retry then succeeds', async () => {
    const token = await blockToken();
    h.replayHang = true;
    const res = await exchangeWithReplayTimeout(token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(lastReason()).toBe('replay check failed: Error: replay store timed out');
    expect(issued()).toEqual([]);
    h.replayHang = false;
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  // The SET landed but its reply was lost to the timeout: without a release the claim would stand for the
  // block token's whole life, and the caller's retry would be refused as a replay.
  it('gives a timed-out claim back when its SET did land: the retry succeeds', async () => {
    const token = await blockToken();
    h.replayApplyThenHang = true;
    const res = await exchangeWithReplayTimeout(token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(lastReason()).toBe('replay check failed: Error: replay store timed out');
    expect(issued()).toEqual([]);
    expect(h.cache.size).toBe(0);
    h.replayApplyThenHang = false;
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  it('gives a timed-out claim back when its SET lands only after the answer: the retry succeeds', async () => {
    const token = await blockToken();
    h.replayDeferred = [];
    const res = await exchangeWithReplayTimeout(token);
    expect(res.status).toBe(503);
    expect(h.cache.size).toBe(0);
    // The held SET lands now, after the 503: the claim it makes is given back as it lands.
    const pending = h.replayDeferred;
    h.replayDeferred = null;
    expect(pending).toHaveLength(1);
    pending[0]();
    await flushMicrotasks();
    expect(h.cache.size).toBe(0);
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  // INVARIANT GUARD (the pre-fix code released nothing on a timeout, so it never violated this): a timed-out
  // request whose claim lost to another's must not give the other's claim back, or the replay would pass.
  it("never gives back another request's claim: a replay after a timed-out duplicate is still refused", async () => {
    const token = await blockToken();
    expect((await exchange(token)).status).toBe(200);
    h.replayApplyThenHang = true; // NX: the duplicate's SET changes nothing, and its reply never comes
    const duplicate = await exchangeWithReplayTimeout(token);
    expect(duplicate.status).toBe(503);
    h.replayApplyThenHang = false;
    expect(h.cache.size).toBe(1);
    const replay = await exchange(token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token already exchanged');
    expect(issued()).toHaveLength(1);
  });

  it('answers 503 when a lookup throws, issues nothing, claims nothing, and the retry succeeds', async () => {
    const token = await blockToken();
    h.dbThrowsOn = 'app_blocks'; // the last lookup before the claim
    const res = await exchange(token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(lastReason()).toMatch(/^lookup failed: /);
    expect(issued()).toEqual([]);
    expect(h.cache.size).toBe(0);
    h.dbThrowsOn = null;
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  it('answers 500 when signing fails after the claim, gives the claim back, and the retry succeeds', async () => {
    const token = await blockToken();
    const signer = getSigner();
    expect(signer).not.toBeNull();
    const sign = vi
      .spyOn(signer!, 'mintAccessTokenJwt')
      .mockRejectedValueOnce(new Error('signer fake: key unavailable'));
    const res = await exchange(token);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(h.replaySetCalled).toBe(true);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(lastReason()).toBe('signing failed');
    expect(issued()).toEqual([]);
    expect(h.cache.size).toBe(0);
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    sign.mockRestore();
  });

  it('refuses a replay', async () => {
    const token = await blockToken();
    expect((await exchange(token)).status).toBe(200);
    const replay = await exchange(token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token already exchanged');
    expect(issued()).toHaveLength(1);
  });

  it('does not burn the block token when the mint fails: the retry succeeds', async () => {
    const token = await blockToken();
    h.sysSetThrows = true;
    const failed = await exchange(token);
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('server_error');
    expect(lastReason()).toBe('exchange record not stored');
    h.sysSetThrows = false;
    const retry = await exchange(token);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
  });

  it('does not burn the block token on a refusal before the mint: the fixed retry succeeds', async () => {
    const token = await blockToken();
    h.tables.OauthClient[0].allowedScopes = TokenScope.AppsRead | TokenScope.UserRead;
    const refused = await exchange(token);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('invalid_scope');
    expect(lastReason()).toBe('app may not hold AppDataRead');
    h.tables.OauthClient[0].allowedScopes = TokenScope.AppDataRead | TokenScope.UserRead;
    expect((await exchange(token)).status).toBe(200);
  });

  it('refuses (fail closed) when the claim cannot be recorded, without burning the token', async () => {
    const token = await blockToken();
    h.redisNull = true;
    const res = await exchange(token);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(issued()).toEqual([]);
    h.redisNull = false;
    expect((await exchange(token)).status).toBe(200);
  });
});

describe('block token exchange — the app and the viewer', () => {
  it('refuses an app the resource does not list', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ apps: ['appblk-other'] });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('app not listed for resource');
  });

  it('refuses an app that may not hold AppDataRead', async () => {
    h.tables.OauthClient[0].allowedScopes = TokenScope.AppsRead | TokenScope.UserRead;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(lastReason()).toBe('app may not hold AppDataRead');
  });

  it('refuses a disabled app', async () => {
    h.tables.OauthClient[0].accessMode = 'disabled';
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('app disabled');
  });

  it('refuses a workload account', async () => {
    h.tables.UserRole = [{ userId: USER_ID, role: 'system:workload' }];
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('workload account');
    expect(issued()).toEqual([]);
  });

  it('refuses a banned viewer', async () => {
    h.tables.User[0].bannedAt = new Date(NOW * 1000);
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('user banned');
  });

  it('refuses while the app block is suspended with no approved block', async () => {
    h.tables.app_blocks[0].status = 'suspended';
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('app block suspended');
    expect(issued()).toEqual([]);
  });

  // The registry's private feed resolves the app from the client id, not the token's block: a token for a
  // suspended block of a client that has another approved block would read THAT block's data there, where
  // the site's document store refuses the token outright.
  it("refuses a token whose block is not the app's approved one, while another block is approved", async () => {
    h.tables.app_blocks[0].status = 'suspended';
    h.tables.app_blocks.push({ id: 'apb_02notes', app_id: APP, status: 'approved' });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe("block is not the app's one approved block");
    expect(issued()).toEqual([]);
  });

  it('refuses while the app has two approved blocks (the registry could not tell which is read)', async () => {
    h.tables.app_blocks.push({ id: 'apb_02notes', app_id: APP, status: 'approved' });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe("block is not the app's one approved block");
    expect(issued()).toEqual([]);
  });

  it("issues for the app's one approved block while another block of it is suspended", async () => {
    h.tables.app_blocks.push({ id: 'apb_02notes', app_id: APP, status: 'suspended' });
    expect((await exchange(await blockToken())).status).toBe(200);
  });

  // The site's document store holds a block token's reads to the token's own ceiling (an SFW host's token
  // reads no mature-rated app's data); the registry's private feed holds them to the viewer's own settings.
  // So a token whose ceiling does not admit every rating is not exchanged.
  it('refuses a token minted with an SFW ceiling, or with none', async () => {
    for (const [maxBrowsingLevel, label] of [
      [3, 'PG | PG13'],
      [15, 'without XXX'],
      [undefined, 'absent'],
      ['31', 'not a number'],
    ] as const) {
      const res = await exchange(await blockToken({ maxBrowsingLevel }));
      expect(res.status, label).toBe(400);
      expect(res.body.error, label).toBe('invalid_grant');
      expect(lastReason(), label).toBe('block token ceiling is not every rating');
    }
    expect(issued()).toEqual([]);
    // The mature bits are what count: Blocked (32) on top of every rating still issues.
    expect((await exchange(await blockToken({ maxBrowsingLevel: 63 }))).status).toBe(200);
  });
});

describe('a minted block-exchange token is inert elsewhere at the hub', () => {
  it('reads as inactive at introspection, at the record check (everything before it passes)', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ introspectors: [INTROSPECTOR] });
    h.tables.OauthClient.push(client(INTROSPECTOR));
    const minted = await exchange(await blockToken());
    expect(minted.status).toBe(200);
    const request = new Request('https://auth.test/api/auth/oauth/introspect', {
      method: 'POST',
      body: new URLSearchParams({ token: String(minted.body.access_token) }),
      headers: { authorization: basic(INTROSPECTOR) },
    });
    const res = await introspectPOST({ request } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false });
    const inactive = h.logs.filter((l) => l.event === 'token_exchange_introspect');
    expect(inactive.map((l) => l.reason)).toEqual(['record does not match token']);
  });

  it('is refused as a subject by the client exchange (signature verified, subject shape refused)', async () => {
    const minted = await exchange(await blockToken());
    expect(minted.status).toBe(200);
    const res = await exchange(String(minted.body.access_token), {
      params: { subject_token_type: ACCESS_TOKEN_TYPE },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    const clientExchange = h.logs.filter((l) => l.event === 'client_token_exchange');
    expect(clientExchange.map((l) => [l.result, l.reason])).toEqual([
      ['refused', 'subject is not a service token'],
    ]);
    expect(issued()).toHaveLength(1);
  });
});

describe('block token verification follows the site', () => {
  // The hub cannot import the site's modules, so its copies of the site's constants are pinned to the
  // site's source text: a change on either side fails here.
  // Each site file by its own literal path, so the apps paths filter (scripts/ci/assert-apps-paths-filter.mjs)
  // can see and cover exactly these files.
  const read = (url: URL) => readFileSync(fileURLToPath(url), 'utf8');
  const BLOCK_TOKEN_SERVICE = new URL(
    '../../../../../../../src/server/services/block-token.service.ts',
    import.meta.url
  );
  const BLOCK_TOKEN_SUBJECT = new URL(
    '../../../../../../../src/server/services/block-token-subject.ts',
    import.meta.url
  );
  const BLOCK_SCOPE_MIDDLEWARE = new URL(
    '../../../../../../../src/server/middleware/block-scope.middleware.ts',
    import.meta.url
  );
  const SITE_ENUMS = new URL('../../../../../../../src/server/common/enums.ts', import.meta.url);
  const BROWSING_LEVEL_CONSTANTS = new URL(
    '../../../../../../../src/shared/constants/browsingLevel.constants.ts',
    import.meta.url
  );

  it('uses the site issuer, audience and signed-in subject pattern', () => {
    const service = read(BLOCK_TOKEN_SERVICE);
    expect(service).toContain("export const BLOCK_TOKEN_ISSUER = 'civitai';");
    expect(service).toContain("export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';");
    const subject = read(BLOCK_TOKEN_SUBJECT);
    expect(subject).toContain('export const USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;');
  });

  it('uses the site age cap and clock tolerance', () => {
    expect(MAX_AGE_SECONDS).toBe(900);
    expect(CLOCK_TOLERANCE_SECONDS).toBe(30);
    const middleware = read(BLOCK_SCOPE_MIDDLEWARE);
    expect(middleware).toContain('const MAX_TOKEN_AGE_DEFAULT_SECONDS = 15 * 60;');
    expect(middleware).toContain('const MAX_TOKEN_AGE_CLOCK_TOLERANCE_SECONDS = 30;');
    expect(middleware).toContain("clockTolerance: '30s',");
  });

  it('holds the same issuer, audience and subject pattern on the hub side', () => {
    expect(BLOCK_TOKEN_ISSUER).toBe('civitai');
    expect(BLOCK_TOKEN_AUDIENCE).toBe('civitai-app-block');
    expect(BLOCK_USER_SUB_RE.source).toBe('^user:[1-9][0-9]{0,11}$');
  });

  it("uses the site's mature browsing-level bits, and the site's red-host ceiling admits them", () => {
    expect(MATURE_BROWSING_LEVELS).toBe(28);
    const enums = read(SITE_ENUMS);
    expect(enums).toContain(
      'export enum NsfwLevel {\n  PG = 1,\n  PG13 = 2,\n  R = 4,\n  X = 8,\n  XXX = 16,'
    );
    const levels = read(BROWSING_LEVEL_CONSTANTS);
    expect(levels).toContain(
      'export const browsingLevels = [\n  NsfwLevel.PG,\n  NsfwLevel.PG13,\n  NsfwLevel.R,\n  NsfwLevel.X,\n  NsfwLevel.XXX,\n] as const;'
    );
    expect(levels).toContain(
      'export const allBrowsingLevelsFlag = flagifyBrowsingLevel([...browsingLevels]);'
    );
    expect(levels).toContain("    case 'red':\n      return allBrowsingLevelsFlag;");
  });

  it('computes the kid as the site does', () => {
    const service = read(BLOCK_TOKEN_SERVICE);
    expect(service).toContain("return createHash('sha256').update(n).digest('hex').slice(0, 32);");
  });
});

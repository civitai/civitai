import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisModule from '$lib/server/redis';
import type * as RequestModule from '$lib/server/auth/request';

// The user token exchange (token route → user-exchange.ts) and introspection of the JWT it mints
// (introspect route → jwt-introspection.ts), end to end through both routes. The db fake FILTERS on the
// where clauses it is given, so a check the code makes in SQL (type, expiry, client) is exercised rather
// than assumed. Each refusal is paired with the same request succeeding once the one condition is removed.

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const kp = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  process.env.NEXTAUTH_SECRET = 'user-exchange-test-secret';
  process.env.AUTH_JWT_PRIVATE_KEY = kp.privateKey;
  process.env.AUTH_JWT_PUBLIC_KEY = kp.publicKey;
  process.env.AUTH_JWT_KID = 'test-kid';
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.CIVITAI_MODERATION_USER_ID = '999';
  return {
    tables: {} as Record<string, Record<string, unknown>[]>,
    queries: [] as { table: string; where: [string, string, unknown][] }[],
    dbThrows: null as null | ((table: string) => boolean),
    redis: new Map<string, { value: string; ex: number }>(),
    cacheRedis: new Map<string, string>(),
    redisGetThrows: false,
    redisGetHangs: false,
    redisSetThrows: false,
    // Like the real sys client (disableOfflineQueue): commands reject until it is ready.
    sysReady: true,
    rate: new Map<string, number>(),
    rateCalls: [] as string[],
    clientIp: '203.0.113.7' as string | null,
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

vi.mock('$lib/server/db/db', () => ({
  db: {
    selectFrom(table: string) {
      const where: [string, string, unknown][] = [];
      const run = () => {
        h.queries.push({ table, where });
        if (h.dbThrows?.(table)) throw new Error(`db down: ${table}`);
        return (h.tables[table] ?? []).filter((r) => where.every((w) => matches(r, w)));
      };
      const qb: Record<string, unknown> = {
        select: () => qb,
        innerJoin: () => qb,
        where: (column: string, op: string, value: unknown) => {
          if (typeof column === 'string') where.push([column, op, value]);
          return qb;
        },
        executeTakeFirst: async () => run()[0],
        execute: async () => run(),
      };
      return qb;
    },
  },
}));

vi.mock('$lib/server/redis', async (orig) => ({
  ...(await orig<typeof RedisModule>()),
  getRedis: () => ({
    async set(key: string, value: string) {
      h.cacheRedis.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return h.cacheRedis.get(key) ?? null;
    },
  }),
  getSysRedis: () => ({
    get isReady() {
      return h.sysReady;
    },
    async set(key: string, value: string, opts: { EX: number }) {
      if (!h.sysReady) throw new Error('The client is offline');
      if (h.redisSetThrows) throw new Error('redis down');
      h.redis.set(key, { value, ex: opts.EX });
      return 'OK';
    },
    async get(key: string) {
      if (!h.sysReady) throw new Error('The client is offline');
      if (h.redisGetThrows) throw new Error('redis down');
      if (h.redisGetHangs) return new Promise<never>(() => undefined);
      return h.redis.get(key)?.value ?? null;
    },
  }),
}));

vi.mock('$lib/server/auth/rate-limit', () => ({
  async checkRateLimit(bucket: string, id: string | null | undefined, limit: number) {
    if (!id) return true;
    const key = `${bucket}:${id}`;
    h.rateCalls.push(key);
    const n = (h.rate.get(key) ?? 0) + 1;
    h.rate.set(key, n);
    return n <= limit;
  },
  async isRateLimited(bucket: string, id: string | null | undefined, limit: number) {
    return !!id && (h.rate.get(`${bucket}:${id}`) ?? 0) >= limit;
  },
}));

vi.mock('$lib/server/axiom', () => ({
  logToAxiom: async (data: Record<string, unknown>) => {
    h.logs.push(data);
  },
  logAxiomError: async () => undefined,
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: () => undefined }));
vi.mock('$lib/server/auth/request', async (orig) => ({
  ...(await orig<typeof RequestModule>()),
  getClientIp: () => h.clientIp,
}));

import { decodeJwt, decodeProtectedHeader, SignJWT, importPKCS8 } from 'jose';
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST as tokenPOST } from '../../../../routes/api/auth/oauth/token/+server';
import { POST as introspectPOST } from '../../../../routes/api/auth/oauth/introspect/+server';
import { WorkerTokenExchangeGrant } from '../worker-grant';
import { invalidateRoleCache } from '../access';
import { workerClientInputError } from '../worker-admin';
import {
  ACCESS_TOKEN_TYPE,
  DEVICE_ID_TOKEN_TYPE,
  SYSTEM_USER_ID,
  SYSTEM_WORKLOAD_ROLE,
  TOKEN_EXCHANGE_GRANT,
} from '../constants';

const AI = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;
const RESOURCE = 'https://registry.test';
const APP = 'app-explorer';
const OTHER_APP = 'app-other';
const RELAY = 'relay-gateway';
const INTROSPECTOR = 'origin-introspector';
const SECRET = 'client-secret-value';
const USER_ID = 42;
const SUBJECT = 'civitai_subject-token-value';

const hour = () => new Date(Date.now() + 3600_000);

function client(id: string, over: Row = {}): Row {
  return {
    id,
    secret: generateSecretHash(SECRET),
    isConfidential: true,
    tokenRateLimit: null,
    userId: 1,
    accessMode: 'open',
    allowedScopes: AI | TokenScope.ModelsRead | TokenScope.UserRead,
    ...over,
  };
}

function registry(over: Row = {}) {
  return JSON.stringify([
    {
      resource: RESOURCE,
      scopes: ['AIServicesRead', 'AIServicesWrite'],
      apps: [APP, OTHER_APP],
      relays: [RELAY],
      introspectors: [INTROSPECTOR],
      ...over,
    },
  ]);
}

function seed() {
  h.tables = {
    OauthClient: [client(APP), client(OTHER_APP), client(RELAY), client(INTROSPECTOR)],
    ApiKey: [
      {
        id: 7,
        key: generateSecretHash(SUBJECT),
        name: `oauth:${APP}`,
        userId: USER_ID,
        clientId: APP,
        tokenScope: AI | TokenScope.ModelsRead | TokenScope.UserRead,
        type: 'Access',
        expiresAt: hour(),
      },
    ],
    User: [{ id: USER_ID, username: 'alice', deletedAt: null, bannedAt: null, muted: false }],
    UserRole: [],
  };
}

const subjectRow = () => h.tables.ApiKey[0];
const userRow = () => h.tables.User[0];
const clientRow = (id: string) => h.tables.OauthClient.find((c) => c.id === id)!;

beforeEach(() => {
  seed();
  h.queries = [];
  h.dbThrows = null;
  h.redis.clear();
  h.cacheRedis.clear();
  h.redisGetThrows = false;
  h.redisGetHangs = false;
  h.redisSetThrows = false;
  h.sysReady = true;
  h.rate.clear();
  h.rateCalls = [];
  h.clientIp = '203.0.113.7';
  h.logs = [];
  invalidateRoleCache();
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.OAUTH_EXCHANGE_RESOURCES = registry();
  process.env.OAUTH_INTROSPECTION_CLIENT_IDS = 'link-service';
  process.env.OAUTH_WORKER_INTROSPECTION_CLIENT_IDS = '';
});

const basic = (id: string, secret = SECRET) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

interface ExchangeOpts {
  caller?: string;
  secret?: string;
  auth?: 'basic' | 'body';
  params?: Record<string, string | undefined>;
  extra?: [string, string][];
  json?: boolean;
  headers?: Record<string, string>;
}

async function exchange(opts: ExchangeOpts = {}) {
  const caller = opts.caller ?? APP;
  const params: Record<string, string | undefined> = {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: SUBJECT,
    subject_token_type: ACCESS_TOKEN_TYPE,
    resource: RESOURCE,
    ...opts.params,
  };
  const headers: Record<string, string> = { ...opts.headers };
  if ((opts.auth ?? 'basic') === 'basic') headers.authorization = basic(caller, opts.secret);
  else {
    params.client_id = caller;
    params.client_secret = opts.secret ?? SECRET;
  }
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.append(k, v);
  for (const [k, v] of opts.extra ?? []) form.append(k, v);
  const request = opts.json
    ? new Request('https://auth.test/api/auth/oauth/token', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(form)),
        headers: { ...headers, 'content-type': 'application/json' },
      })
    : new Request('https://auth.test/api/auth/oauth/token', {
        method: 'POST',
        body: form,
        headers,
      });
  const res = await tokenPOST({ request } as never);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Row };
}

async function introspect(token: string, caller = INTROSPECTOR, secret = SECRET) {
  const request = new Request('https://auth.test/api/auth/oauth/introspect', {
    method: 'POST',
    body: new URLSearchParams({ token }),
    headers: { authorization: basic(caller, secret) },
  });
  const res = await introspectPOST({ request } as never);
  return { status: res.status, headers: res.headers, body: (await res.json()) as Row };
}

async function minted(opts: ExchangeOpts = {}): Promise<string> {
  const res = await exchange(opts);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

// ─── Exchange ─────────────────────────────────────────────────

describe('user token exchange — dispatch', () => {
  it('never reaches the worker grant', async () => {
    const spy = vi.spyOn(WorkerTokenExchangeGrant.prototype, 'handle');
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(decodeProtectedHeader(res.body.access_token as string).typ).toBe('at+jwt');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('no workload client can be registered to accept access tokens as a subject', () => {
    const input = {
      id: 'pool-1',
      name: 'Pool',
      provider: 'Civitai',
      subjectTokenTypes: [ACCESS_TOKEN_TYPE],
    } as never;
    expect(workerClientInputError(input)).toMatch(/unknown subject token type/);
    // Control: the same client with a worker subject type is valid.
    expect(
      workerClientInputError({
        ...(input as object),
        subjectTokenTypes: [DEVICE_ID_TOKEN_TYPE],
      } as never)
    ).toBeNull();
  });
});

describe('client ids and resource identifiers stay apart', () => {
  it.each(['https://registry.test', 'pool:1', 'pool/1'])(
    'no workload client can be registered with the id %s',
    (id) => {
      const input = {
        id,
        name: 'Pool',
        provider: 'Civitai',
        subjectTokenTypes: [DEVICE_ID_TOKEN_TYPE],
      };
      expect(workerClientInputError(input as never)).toMatch(/client id/);
      expect(workerClientInputError({ ...input, id: 'pool-1' } as never)).toBeNull();
    }
  );
});

describe('user token exchange — client authentication', () => {
  it('accepts Basic and body credentials', async () => {
    expect((await exchange({ auth: 'basic' })).status).toBe(200);
    expect((await exchange({ auth: 'body' })).status).toBe(200);
  });

  it('refuses a body client_id that differs from the Basic one', async () => {
    const res = await exchange({ params: { client_id: OTHER_APP } });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.headers.get('www-authenticate')).toMatch(/^Basic/);
    // Control: the same request with a matching body client_id passes.
    expect((await exchange({ params: { client_id: APP } })).status).toBe(200);
  });

  it('refuses a public client', async () => {
    clientRow(APP).isConfidential = false;
    expect((await exchange()).body.error).toBe('invalid_client');
    clientRow(APP).isConfidential = true;
    expect((await exchange()).status).toBe(200);
  });

  it('refuses a wrong secret', async () => {
    const res = await exchange({ secret: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('user token exchange — rate limits', () => {
  it('charges failed secret checks per IP and never refuses a caller whose secret checks out', async () => {
    for (let i = 0; i < 120; i++) expect((await exchange({ secret: 'wrong' })).status).toBe(401);
    const blocked = await exchange({ secret: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    // The same IP with the right secret still exchanges.
    expect((await exchange()).status).toBe(200);
  });

  it('charges failures with no resolvable IP to one shared bucket, never to the claimed client id', async () => {
    h.clientIp = null;
    await exchange({ secret: 'wrong' });
    expect(h.rateCalls).toContain('oauth:token-exchange-ip:no-ip');
    expect(h.rateCalls.some((k) => k.endsWith(`:${APP}`))).toBe(false);
  });

  it('limits each authenticated client, and never applies the general token buckets', async () => {
    h.rate.set(`oauth:token-exchange:${APP}`, 600);
    const res = await exchange();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    // Another client is unaffected.
    expect((await exchange({ caller: RELAY })).status).toBe(200);
    expect(
      h.rateCalls.filter((k) => /^oauth:(token|worker-token|token-overflow):/.test(k))
    ).toEqual([]);
  });

  it("uses the client's staff-set limit when it has one", async () => {
    clientRow(APP).userId = SYSTEM_USER_ID;
    clientRow(APP).tokenRateLimit = 1000;
    h.rate.set(`oauth:token-exchange:${APP}`, 600);
    expect((await exchange()).status).toBe(200);
  });
});

describe('user token exchange — request checks, in order', () => {
  it('needs a subject_token', async () => {
    const res = await exchange({ params: { subject_token: undefined } });
    expect(res.body.error).toBe('invalid_request');
  });

  it('needs exactly one resource', async () => {
    expect((await exchange({ extra: [['resource', RESOURCE]] })).body.error).toBe(
      'invalid_request'
    );
    expect((await exchange({ params: { resource: undefined } })).body.error).toBe(
      'invalid_request'
    );
    expect((await exchange()).status).toBe(200);
  });

  it('only issues access tokens', async () => {
    const jwt = 'urn:ietf:params:oauth:token-type:jwt';
    expect((await exchange({ params: { requested_token_type: jwt } })).body.error).toBe(
      'invalid_request'
    );
    expect((await exchange({ params: { requested_token_type: ACCESS_TOKEN_TYPE } })).status).toBe(
      200
    );
  });

  it('does not take an actor_token', async () => {
    const res = await exchange({
      params: { actor_token: 'x', actor_token_type: ACCESS_TOKEN_TYPE },
    });
    expect(res.body.error).toBe('invalid_request');
  });

  it('needs a form-encoded body', async () => {
    expect((await exchange({ json: true })).body.error).toBe('invalid_request');
  });

  it('refuses an unregistered resource', async () => {
    const res = await exchange({ params: { resource: `${RESOURCE}/other` } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });

  it('refuses a caller on none of the resource lists', async () => {
    h.tables.OauthClient.push(client('stranger'));
    expect((await exchange({ caller: 'stranger' })).body.error).toBe('unauthorized_client');
  });

  const subjectCases: [string, (row: Row) => void][] = [
    ['unknown token', (r) => (r.key = 'other-hash')],
    ['a refresh token', (r) => (r.type = 'Refresh')],
    ['a user API key', (r) => ((r.type = 'User'), (r.clientId = null))],
    ['an expired token', (r) => (r.expiresAt = new Date(Date.now() - 1000))],
    ['a token with no expiry', (r) => (r.expiresAt = null)],
    [
      'a client-only scope',
      (r) => (r.tokenScope = (r.tokenScope as number) | TokenScope.WorkerRegister),
    ],
    ['a client-credentials token', (r) => (r.name = `oauth-cc:${APP}`)],
    [
      'the system account',
      (r) => {
        r.userId = SYSTEM_USER_ID;
        h.tables.User.push({ ...userRow(), id: SYSTEM_USER_ID });
      },
    ],
  ];
  it.each(subjectCases)('refuses %s as the subject', async (_, mutate) => {
    const original = { ...subjectRow() };
    mutate(subjectRow());
    expect((await exchange()).body.error).toBe('invalid_grant');
    // Control: the unmutated token exchanges.
    h.tables.ApiKey[0] = original;
    expect((await exchange()).status).toBe(200);
  });

  it('refuses a token whose user holds the workload role', async () => {
    h.tables.UserRole.push({ userId: USER_ID, role: SYSTEM_WORKLOAD_ROLE });
    expect((await exchange()).body.error).toBe('invalid_grant');
    h.tables.UserRole = [];
    invalidateRoleCache();
    expect((await exchange()).status).toBe(200);
  });

  it("refuses a relay exchanging a token from an app the resource doesn't list", async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ apps: [OTHER_APP] });
    expect((await exchange({ caller: RELAY })).body.error).toBe('unauthorized_client');
    process.env.OAUTH_EXCHANGE_RESOURCES = registry();
    expect((await exchange({ caller: RELAY })).status).toBe(200);
  });

  it("refuses another listed app exchanging a token that isn't its own", async () => {
    expect((await exchange({ caller: OTHER_APP })).body.error).toBe('unauthorized_client');
    expect((await exchange({ caller: APP })).status).toBe(200);
  });

  it('refuses a disabled app or caller', async () => {
    clientRow(APP).accessMode = 'disabled';
    expect((await exchange({ caller: RELAY })).body.error).toBe('unauthorized_client');
    clientRow(APP).accessMode = 'open';
    clientRow(RELAY).accessMode = 'disabled';
    expect((await exchange({ caller: RELAY })).body.error).toBe('unauthorized_client');
    clientRow(RELAY).accessMode = 'open';
    expect((await exchange({ caller: RELAY })).status).toBe(200);
  });

  const userCases: [string, (row: Row) => void][] = [
    ['deleted', (u) => (u.deletedAt = new Date())],
    ['banned', (u) => (u.bannedAt = new Date())],
    ['muted, for AI Services scopes', (u) => (u.muted = true)],
    ['the moderation account', (u) => (u.id = 999)],
  ];
  it.each(userCases)('refuses a user who is %s', async (_, mutate) => {
    mutate(userRow());
    if (userRow().id === 999) subjectRow().userId = 999;
    expect((await exchange()).body.error).toBe('invalid_grant');
    seed();
    expect((await exchange()).status).toBe(200);
  });

  it('refuses a user outside a testers-only app', async () => {
    clientRow(APP).accessMode = 'testers';
    expect((await exchange()).body.error).toBe('invalid_grant');
    h.tables.UserRole.push({ userId: USER_ID, role: 'tester' });
    invalidateRoleCache();
    expect((await exchange()).status).toBe(200);
  });

  it('refuses when the hub has no issuer', async () => {
    process.env.AUTH_JWT_ISSUER = '';
    const res = await exchange();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body).not.toHaveProperty('access_token');
  });

  it('issues no token when the exchange record cannot be stored', async () => {
    h.redisSetThrows = true;
    const res = await exchange();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body).not.toHaveProperty('access_token');
    h.redisSetThrows = false;
    expect((await exchange()).status).toBe(200);
  });

  it('waits for the record store to be ready on a cold start', async () => {
    h.sysReady = false;
    setTimeout(() => (h.sysReady = true), 150);
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(h.redis.has(`oauth:xchg:${decodeJwt(res.body.access_token as string).jti}`)).toBe(true);
  });

  it('issues no token when the record store is not ready in time', async () => {
    h.sysReady = false;
    const res = await exchange();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('server_error');
    expect(res.body).not.toHaveProperty('access_token');
  });

  it('answers 503 when a lookup fails', async () => {
    h.dbThrows = (t) => t === 'User';
    const res = await exchange();
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(res.body).not.toHaveProperty('access_token');
    h.dbThrows = null;
    expect((await exchange()).status).toBe(200);
  });
});

describe('user token exchange — scope', () => {
  it("defaults to the token's scope within the resource's cap", async () => {
    const res = await exchange();
    expect(res.body.scope).toBe('AIServicesRead AIServicesWrite');
    // ModelsRead and UserRead are on the token but not the resource.
    expect(decodeJwt(res.body.access_token as string).scope).toBe('AIServicesRead AIServicesWrite');
  });

  it('narrows to a requested subset', async () => {
    const res = await exchange({ params: { scope: 'AIServicesRead' } });
    expect(res.body.scope).toBe('AIServicesRead');
  });

  it('refuses a requested scope outside the grant', async () => {
    expect((await exchange({ params: { scope: 'AIServicesRead ModelsRead' } })).body.error).toBe(
      'invalid_scope'
    );
  });

  it("follows the app's current ceiling, and refuses when nothing is left", async () => {
    clientRow(APP).allowedScopes = TokenScope.AIServicesRead | TokenScope.UserRead;
    expect((await exchange()).body.scope).toBe('AIServicesRead');
    clientRow(APP).allowedScopes = TokenScope.ModelsRead;
    expect((await exchange()).body.error).toBe('invalid_scope');
  });
});

describe('user token exchange — the JWT', () => {
  it('has the at+jwt header and only the documented claims', async () => {
    const res = await exchange();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.body).toMatchObject({
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: 900,
    });
    const token = res.body.access_token as string;
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', typ: 'at+jwt', kid: 'test-kid' });
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(
      ['aud', 'client_id', 'exp', 'iat', 'iss', 'jti', 'scope', 'sub'].sort()
    );
    expect(claims).toMatchObject({
      iss: 'https://auth.test',
      sub: String(USER_ID),
      aud: RESOURCE,
      client_id: APP,
    });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('names the relay in act on a relay exchange', async () => {
    const claims = decodeJwt(await minted({ caller: RELAY }));
    expect(claims.act).toEqual({ sub: RELAY });
    expect(claims.client_id).toBe(APP);
  });

  it('lasts at most 15 minutes, and never past the subject token', async () => {
    let claims = decodeJwt(await minted());
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
    const subjectExp = new Date(Date.now() + 120_000);
    subjectRow().expiresAt = subjectExp;
    claims = decodeJwt(await minted());
    expect(claims.exp).toBe(Math.floor(subjectExp.getTime() / 1000));
  });

  it('records the exchange under its jti until a minute past expiry', async () => {
    const claims = decodeJwt(await minted({ caller: RELAY }));
    const entry = h.redis.get(`oauth:xchg:${claims.jti}`)!;
    expect(JSON.parse(entry.value)).toEqual({
      subjectKeyId: 7,
      userId: USER_ID,
      clientId: APP,
      actor: RELAY,
      resource: RESOURCE,
      scopeBits: AI,
      exp: claims.exp,
    });
    expect(entry.ex).toBe((claims.exp as number) - (claims.iat as number) + 60);
  });

  // Introspection reads a missing record as inactive, so the record must live where keys are not
  // evicted under memory pressure: the system Redis, not the cache. Don't move it back.
  it('keeps the exchange record in the system Redis, not the cache', async () => {
    const claims = decodeJwt(await minted({ caller: RELAY }));
    const key = `oauth:xchg:${claims.jti}`;
    expect([...h.cacheRedis.keys()]).toEqual([]);
    expect(h.redis.has(key)).toBe(true);
  });

  it('logs the outcome without the subject token or the JWT', async () => {
    const token = await minted();
    await exchange({ params: { resource: 'https://nowhere.test' } });
    const lines = h.logs.filter((l) => l.event === 'token_exchange');
    expect(lines.map((l) => l.result)).toEqual(['issued', 'refused']);
    expect(lines[1].error).toBe('invalid_target');
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(SUBJECT);
    expect(text).not.toContain(token);
  });
});

// ─── Introspection ────────────────────────────────────────────

describe('introspection of an exchanged JWT', () => {
  it('answers active with the token claims and scope names', async () => {
    const token = await minted({ caller: RELAY });
    const claims = decodeJwt(token);
    const res = await introspect(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      token_type: 'access_token',
      iss: 'https://auth.test',
      sub: String(USER_ID),
      aud: RESOURCE,
      client_id: APP,
      act: { sub: RELAY },
      scope: 'AIServicesRead AIServicesWrite',
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
    });
    expect(h.rateCalls).toContain(`oauth:introspect-jwt:${INTROSPECTOR}`);
  });

  const inactiveCases: [string, () => void][] = [
    ['the subject token was revoked', () => (h.tables.ApiKey = [])],
    ['the subject token expired', () => (subjectRow().expiresAt = new Date(Date.now() - 1000))],
    ['the user was banned', () => (userRow().bannedAt = new Date())],
    ['the user was deleted', () => (userRow().deletedAt = new Date())],
    ['the user was muted', () => (userRow().muted = true)],
    ['the app was disabled', () => (clientRow(APP).accessMode = 'disabled')],
    ['the relay was disabled', () => (clientRow(RELAY).accessMode = 'disabled')],
    ['the exchange record is gone', () => h.redis.clear()],
    [
      'the app left the resource',
      () => (process.env.OAUTH_EXCHANGE_RESOURCES = registry({ apps: [OTHER_APP] })),
    ],
    [
      'the relay left the resource',
      () => (process.env.OAUTH_EXCHANGE_RESOURCES = registry({ relays: [] })),
    ],
    ["the app's ceiling lost every exchanged scope", () => (clientRow(APP).allowedScopes = 0)],
  ];
  it.each(inactiveCases)('is inactive once %s', async (_, change) => {
    const token = await minted({ caller: RELAY });
    // Control: the same token is active before the change.
    expect((await introspect(token)).body.active).toBe(true);
    change();
    const res = await introspect(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false });
  });

  it("narrows scope to the app's current ceiling", async () => {
    const token = await minted();
    clientRow(APP).allowedScopes = TokenScope.AIServicesRead;
    expect((await introspect(token)).body.scope).toBe('AIServicesRead');
  });

  it('is inactive for an introspector of another resource', async () => {
    const token = await minted();
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      ...JSON.parse(registry({ introspectors: [] })),
      {
        resource: 'https://other.test',
        scopes: ['AIServicesRead'],
        apps: [APP],
        introspectors: [INTROSPECTOR],
      },
    ]);
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('answers invalid_client to a caller on no introspector list and neither env list', async () => {
    const token = await minted();
    h.tables.OauthClient.push(client('stranger'));
    const res = await introspect(token, 'stranger');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    // On an env list but not the resource's introspectors: authenticated, but the token is not theirs.
    expect((await introspect(token, 'link-service')).status).toBe(401); // no such client row
    h.tables.OauthClient.push(client('link-service'));
    expect((await introspect(token, 'link-service')).body).toEqual({ active: false });
  });

  it('answers invalid_client to a wrong secret', async () => {
    const token = await minted();
    expect((await introspect(token, INTROSPECTOR, 'wrong')).status).toBe(401);
  });

  it('is inactive for a bad signature and never falls through to the opaque lookup', async () => {
    const token = await minted();
    const [hd, pl, sig] = token.split('.');
    const badSignature = `${hd}.${pl}.${sig.startsWith('A') ? 'B' : 'A'}${sig.slice(1)}`;
    // An opaque row with this exact hash: the opaque path, if reached, would look it up by hash.
    h.tables.ApiKey.push({ ...subjectRow(), id: 8, key: generateSecretHash(badSignature) });
    h.queries = [];
    expect((await introspect(badSignature)).body).toEqual({ active: false });
    const hashLookups = h.queries.filter(
      (q) => q.table === 'ApiKey' && q.where.some(([c]) => c === 'ApiKey.key' || c === 'key')
    );
    expect(hashLookups).toEqual([]);
  });

  it('sends a JWT of any other typ down the opaque path, unchanged', async () => {
    const key = await importPKCS8(process.env.AUTH_JWT_PRIVATE_KEY!, 'ES256');
    const session = await new SignJWT({ user: { id: USER_ID } })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' })
      .setIssuer('https://auth.test')
      .setExpirationTime('1h')
      .sign(key);
    h.tables.OauthClient.push(client('link-service'));
    h.queries = [];
    await introspect(session, 'link-service');
    expect(
      h.queries.some((q) => q.table === 'ApiKey' && q.where.some(([c]) => c === 'ApiKey.key'))
    ).toBe(true);
    // Control: an at+jwt introspected by the same caller makes no hash lookup.
    const token = await minted();
    h.queries = [];
    await introspect(token, 'link-service');
    expect(
      h.queries.some((q) => q.table === 'ApiKey' && q.where.some(([c]) => c === 'ApiKey.key'))
    ).toBe(false);
  });

  it('is inactive when the hub has no issuer', async () => {
    const token = await minted();
    process.env.AUTH_JWT_ISSUER = '';
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('answers 503 with Retry-After when the exchange record cannot be read', async () => {
    const token = await minted();
    expect((await introspect(token)).body.active).toBe(true);
    h.redisGetThrows = true;
    const res = await introspect(token);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({ error: 'temporarily_unavailable' });
  });

  it('answers 503 when the exchange record read does not return', async () => {
    const token = await minted();
    h.redisGetHangs = true;
    const res = await introspect(token);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('waits for the record store to be ready before reading', async () => {
    const token = await minted();
    h.sysReady = false;
    setTimeout(() => (h.sysReady = true), 150);
    expect((await introspect(token)).body.active).toBe(true);
  });

  it('answers 503, not inactive, when the record store is not ready in time', async () => {
    const token = await minted();
    h.sysReady = false;
    const res = await introspect(token);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'temporarily_unavailable' });
  });

  it('answers 503 when a database lookup fails', async () => {
    const token = await minted();
    h.dbThrows = (t) => t === 'ApiKey';
    const res = await introspect(token);
    expect(res.status).toBe(503);
    expect(res.body).not.toHaveProperty('active');
    h.dbThrows = null;
    expect((await introspect(token)).body.active).toBe(true);
  });
});

describe('introspection of an exchanged JWT — before the caller is known', () => {
  it('answers 503, not 401, when the client lookup fails', async () => {
    const token = await minted();
    h.dbThrows = (t) => t === 'OauthClient';
    const res = await introspect(token);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    h.dbThrows = null;
    expect((await introspect(token)).status).toBe(200);
  });
});

describe('user token exchange — client_id mismatch with an encoded Basic id', () => {
  it('compares the body client_id to the Basic id as client authentication decodes it', async () => {
    h.tables.OauthClient.push(client('app.v2'));
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ relays: [RELAY, 'app.v2'] });
    // RFC 6749 §2.3.1 form-encodes the Basic id; it decodes to app.v2, which the body names too.
    const authorization = `Basic ${Buffer.from(`app%2Ev2:${SECRET}`).toString('base64')}`;
    const res = await exchange({ caller: 'app.v2', auth: 'body', headers: { authorization } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(decodeJwt(res.body.access_token as string).act).toEqual({ sub: 'app.v2' });
  });
});

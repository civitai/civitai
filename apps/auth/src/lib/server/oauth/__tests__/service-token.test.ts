import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisModule from '$lib/server/redis';
import type * as RequestModule from '$lib/server/auth/request';

// Service tokens (client_credentials with a resource, token route → service-token.ts) and their
// introspection (introspect route → jwt-introspection.ts), end to end through both routes, on the same
// fakes as user-exchange.test.ts: the db fake filters on the where clauses it is given.

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
    dbThrows: null as null | ((table: string, where: [string, string, unknown][]) => boolean),
    redis: new Map<string, { value: string; ex: number }>(),
    cacheRedis: new Map<string, string>(),
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
        if (h.dbThrows?.(table, where)) throw new Error(`db down: ${table}`);
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

import { decodeJwt, decodeProtectedHeader } from 'jose';
import { createAuthVerifier, createSessionSigner } from '@civitai/auth';
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST as tokenPOST } from '../../../../routes/api/auth/oauth/token/+server';
import { POST as introspectPOST } from '../../../../routes/api/auth/oauth/introspect/+server';
import { ACCESS_TOKEN_TYPE, SERVICE_GRANT, TOKEN_EXCHANGE_GRANT } from '../constants';

const RESOURCE = 'https://orchestration.test';
const OTHER_RESOURCE = 'https://other.test';
const SERVICE = '0b7c4a52-1f3e-4d6a-9c2b-5e8f7a6d4c3b';
const APP = 'app-explorer';
const INTROSPECTOR = 'orch-introspector';
const OTHER_INTROSPECTOR = 'other-introspector';
const SECRET = 'client-secret-value';
const USER_ID = 42;
const SUBJECT = 'civitai_subject-token-value';
const AI = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;

function client(id: string, over: Row = {}): Row {
  return {
    id,
    secret: generateSecretHash(SECRET),
    isConfidential: true,
    tokenRateLimit: null,
    userId: 1,
    accessMode: 'open',
    grants: ['authorization_code', 'refresh_token'],
    allowedScopes: AI | TokenScope.UserRead,
    ...over,
  };
}

// As the admin page's createServiceClient writes it.
const serviceClient = (over: Row = {}) =>
  client(SERVICE, {
    userId: -1,
    grants: [SERVICE_GRANT],
    allowedScopes: TokenScope.UserRead,
    ...over,
  });

interface ServiceOver {
  scopes?: string[];
  roles?: string[];
  uid?: number;
}

function registry(service: ServiceOver | null = {}) {
  return JSON.stringify([
    {
      resource: RESOURCE,
      scopes: ['AIServicesRead', 'AIServicesWrite'],
      apps: [APP],
      introspectors: [INTROSPECTOR],
      services: service
        ? [
            {
              client: SERVICE,
              scopes: ['AIServicesWrite'],
              roles: ['trusted', 'Manager'],
              uid: -1001,
              ...service,
            },
          ]
        : [],
    },
    {
      resource: OTHER_RESOURCE,
      scopes: ['AIServicesRead'],
      apps: [APP],
      introspectors: [OTHER_INTROSPECTOR],
    },
  ]);
}

beforeEach(() => {
  h.tables = {
    OauthClient: [serviceClient(), client(APP), client(INTROSPECTOR), client(OTHER_INTROSPECTOR)],
    ApiKey: [
      {
        id: 7,
        key: generateSecretHash(SUBJECT),
        name: `oauth:${APP}`,
        userId: USER_ID,
        clientId: APP,
        tokenScope: AI | TokenScope.UserRead,
        type: 'Access',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    ],
    User: [{ id: USER_ID, username: 'alice', deletedAt: null, bannedAt: null, muted: false }],
    UserRole: [],
  };
  h.queries = [];
  h.dbThrows = null;
  h.redis.clear();
  h.cacheRedis.clear();
  h.redisSetThrows = false;
  h.sysReady = true;
  h.rate.clear();
  h.rateCalls = [];
  h.clientIp = '203.0.113.7';
  h.logs = [];
  process.env.AUTH_JWT_ISSUER = 'https://auth.test';
  process.env.OAUTH_EXCHANGE_RESOURCES = registry();
  process.env.OAUTH_INTROSPECTION_CLIENT_IDS = '';
  process.env.OAUTH_WORKER_INTROSPECTION_CLIENT_IDS = '';
});

const basic = (id: string, secret = SECRET) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const serviceRow = () => h.tables.OauthClient.find((c) => c.id === SERVICE)!;

interface TokenOpts {
  caller?: string;
  secret?: string;
  resource?: string | null;
  extra?: [string, string][];
  json?: boolean;
  scope?: string;
}

async function serviceToken(opts: TokenOpts = {}) {
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (opts.resource !== null) form.append('resource', opts.resource ?? RESOURCE);
  if (opts.scope !== undefined) form.append('scope', opts.scope);
  for (const [k, v] of opts.extra ?? []) form.append(k, v);
  const headers: Record<string, string> = {
    authorization: basic(opts.caller ?? SERVICE, opts.secret),
  };
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

async function minted(opts: TokenOpts = {}): Promise<string> {
  const res = await serviceToken(opts);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

async function introspect(token: string, caller = INTROSPECTOR) {
  const request = new Request('https://auth.test/api/auth/oauth/introspect', {
    method: 'POST',
    body: new URLSearchParams({ token }),
    headers: { authorization: basic(caller) },
  });
  const res = await introspectPOST({ request } as never);
  return { status: res.status, body: (await res.json()) as Row };
}

describe('service token — mint', () => {
  it('issues an at+jwt for a listed service client', async () => {
    const res = await serviceToken();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.body).toEqual({
      access_token: expect.any(String),
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'AIServicesWrite',
    });
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: 'service_token', result: 'ok', client: SERVICE })
    );
  });

  it('refuses the same client once the resource no longer lists it', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry(null);
    const res = await serviceToken();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
  });

  it('refuses an unregistered resource', async () => {
    const res = await serviceToken({ resource: 'https://nowhere.test' });
    expect(res.body.error).toBe('invalid_target');
  });

  it('refuses a disabled service client', async () => {
    serviceRow().accessMode = 'disabled';
    const res = await serviceToken();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
  });

  it('refuses a service client not owned by the system account', async () => {
    serviceRow().userId = 5;
    expect((await serviceToken()).body.error).toBe('unauthorized_client');
  });

  it('issues no service token to a client holding any grant besides the service grant', async () => {
    serviceRow().grants = [SERVICE_GRANT, 'client_credentials'];
    // It takes the general path, as without a resource.
    await serviceToken();
    expect(h.logs.some((l) => l.event === 'service_token')).toBe(false);
    expect(h.redis.size).toBe(0);
    // Control: the exact grant gets a service token.
    serviceRow().grants = [SERVICE_GRANT];
    await minted();
    expect(h.redis.size).toBe(1);
  });

  it('needs exactly one resource, in a form body', async () => {
    const twice = await serviceToken({ extra: [['resource', OTHER_RESOURCE]] });
    expect(twice.body.error).toBe('invalid_request');
    const empty = await serviceToken({ resource: '' });
    expect(empty.body.error).toBe('invalid_request');
    const json = await serviceToken({ json: true });
    expect(json.body.error).toBe('invalid_request');
  });

  it('narrows to a requested scope within the entry, and refuses one outside it', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({
      scopes: ['AIServicesRead', 'AIServicesWrite'],
    });
    const narrowed = await serviceToken({ scope: 'AIServicesRead' });
    expect(narrowed.body.scope).toBe('AIServicesRead');
    const outside = await serviceToken({ scope: 'ModelsRead' });
    expect(outside.body.error).toBe('invalid_scope');
    const openid = await serviceToken({ scope: 'openid AIServicesRead' });
    expect(openid.body.error).toBe('invalid_scope');
  });

  it("takes scope from the entry alone: the client row's allowedScopes plays no part", async () => {
    serviceRow().allowedScopes = 0;
    const res = await serviceToken();
    expect(res.body.scope).toBe('AIServicesWrite');
    serviceRow().allowedScopes = AI | TokenScope.ModelsRead | TokenScope.UserRead;
    expect((await serviceToken()).body.scope).toBe('AIServicesWrite');
  });

  it('issues no token when the record cannot be stored', async () => {
    h.redisSetThrows = true;
    const res = await serviceToken();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'server_error', error_description: 'Internal error' });
    expect(res.body).not.toHaveProperty('access_token');
  });

  it('issues no token when the hub has no issuer', async () => {
    process.env.AUTH_JWT_ISSUER = '';
    expect((await serviceToken()).body.error).toBe('server_error');
  });
});

describe('service token — dispatch', () => {
  it('sends a failed client check down the general path, with its limits and none of its own', async () => {
    // What the library then answers is in client-credentials.test.ts; this fake db cannot run it.
    await serviceToken({ secret: 'wrong' });
    expect(h.rateCalls).toContain('oauth:token:203.0.113.7');
    expect(h.rateCalls.some((k) => k.startsWith('oauth:token-service'))).toBe(false);
    expect(h.logs.some((l) => l.event === 'service_token')).toBe(false);
  });

  it('charges a service client its own limit and never the per-IP token limit', async () => {
    for (let i = 0; i < 60; i++) await minted();
    expect(h.rateCalls).not.toContain('oauth:token:203.0.113.7');
    const res = await serviceToken();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
  });

  it('charges a refused request to the client limit too', async () => {
    for (let i = 0; i < 60; i++) await serviceToken({ resource: '' });
    expect((await serviceToken()).body.error).toBe('rate_limited');
  });

  it('checks no secret for an IP past both the token limit and its failed-check budget', async () => {
    h.rate.set('oauth:token:203.0.113.7', 20);
    // Past the token limit alone, a service client still gets its token.
    await minted();
    h.rate.set('oauth:token-overflow:203.0.113.7', 120);
    const res = await serviceToken();
    expect(res.status).toBe(429);
    expect(h.redis.size).toBe(1);
  });
});

describe('service token — the JWT', () => {
  it('names the client as sub, carries the entry roles and uid, and nothing about a user', async () => {
    const token = await minted();
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'test-kid', typ: 'at+jwt' });
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(
      [
        'aud',
        'civitai_uid',
        'client_id',
        'exp',
        'iat',
        'iss',
        'jti',
        'roles',
        'scope',
        'sub',
      ].sort()
    );
    expect(claims).toMatchObject({
      iss: 'https://auth.test',
      sub: SERVICE,
      client_id: SERVICE,
      aud: RESOURCE,
      scope: 'AIServicesWrite',
      roles: ['trusted', 'Manager'],
      civitai_uid: -1001,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
  });

  it('is not a session', async () => {
    const verifier = createAuthVerifier({
      publicKeyPem: process.env.AUTH_JWT_PUBLIC_KEY,
      issuer: 'https://auth.test',
    });
    expect(await verifier.verifyToken(await minted())).toBeNull();
    // Control: a session token from the same key verifies.
    const session = await createSessionSigner().mintSessionToken(
      { user: { id: USER_ID } },
      { expiresIn: 3600 }
    );
    expect(await verifier.verifyToken(session)).toMatchObject({ user: { id: USER_ID } });
  });

  it('is not a subject the user token exchange accepts, nor one an app may exchange', async () => {
    const exchange = async (subject: string) => {
      const form = new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: subject,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: RESOURCE,
      });
      const res = await tokenPOST({
        request: new Request('https://auth.test/api/auth/oauth/token', {
          method: 'POST',
          body: form,
          headers: { authorization: basic(APP) },
        }),
      } as never);
      return { status: res.status, body: (await res.json()) as Row };
    };
    // A service token goes to the client token exchange (client-exchange.ts), never the user one, and
    // an app is no relay there.
    const refused = await exchange(await minted());
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('unauthorized_client');
    expect(refused.body).not.toHaveProperty('access_token');
    expect(h.logs.some((l) => l.event === 'token_exchange')).toBe(false);
    // Control: the app's own access token exchanges.
    expect((await exchange(SUBJECT)).status).toBe(200);
  });

  it("puts no roles or uid on a user's exchanged token", async () => {
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: SUBJECT,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource: RESOURCE,
    });
    const res = await tokenPOST({
      request: new Request('https://auth.test/api/auth/oauth/token', {
        method: 'POST',
        body: form,
        headers: { authorization: basic(APP) },
      }),
    } as never);
    const body = (await res.json()) as Row;
    expect(res.status).toBe(200);
    const claims = decodeJwt(body.access_token as string);
    expect(claims).not.toHaveProperty('roles');
    expect(claims).not.toHaveProperty('civitai_uid');
    // Its introspection answer carries neither either.
    const answer = await introspect(body.access_token as string);
    expect(answer.body.active).toBe(true);
    expect(answer.body).not.toHaveProperty('roles');
    expect(answer.body).not.toHaveProperty('civitai_uid');
  });
});

describe('service token — introspection', () => {
  it('answers active with roles and uid from the current entry', async () => {
    const token = await minted();
    const res = await introspect(token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      active: true,
      token_type: 'access_token',
      iss: 'https://auth.test',
      sub: SERVICE,
      aud: RESOURCE,
      client_id: SERVICE,
      scope: 'AIServicesWrite',
      roles: ['trusted', 'Manager'],
      civitai_uid: -1001,
      exp: expect.any(Number),
      iat: expect.any(Number),
      jti: expect.any(String),
    });
    // A role removed from the entry is gone at the next introspection.
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ roles: ['trusted'] });
    expect((await introspect(token)).body.roles).toEqual(['trusted']);
  });

  it("reads a user's token as a user's even when its app id equals the user id", async () => {
    const NUMERIC_APP = String(USER_ID);
    h.tables.OauthClient.push(client(NUMERIC_APP));
    h.tables.ApiKey.push({
      ...h.tables.ApiKey[0],
      id: 8,
      key: generateSecretHash('civitai_numeric-app-token'),
      name: `oauth:${NUMERIC_APP}`,
      clientId: NUMERIC_APP,
    });
    const [orch, other] = JSON.parse(registry()) as Row[];
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      { ...orch, apps: [APP, NUMERIC_APP] },
      other,
    ]);
    const res = await tokenPOST({
      request: new Request('https://auth.test/api/auth/oauth/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: 'civitai_numeric-app-token',
          subject_token_type: ACCESS_TOKEN_TYPE,
          resource: RESOURCE,
        }),
        headers: { authorization: basic(NUMERIC_APP) },
      }),
    } as never);
    const token = ((await res.json()) as Row).access_token as string;
    expect(decodeJwt(token)).toMatchObject({ sub: NUMERIC_APP, client_id: NUMERIC_APP });
    expect((await introspect(token)).body).toMatchObject({ active: true, sub: NUMERIC_APP });
  });

  it('is inactive for an introspector of another resource', async () => {
    const token = await minted();
    expect((await introspect(token, OTHER_INTROSPECTOR)).body).toEqual({ active: false });
  });

  it('is inactive once the client is disabled', async () => {
    const token = await minted();
    expect((await introspect(token)).body.active).toBe(true);
    serviceRow().accessMode = 'disabled';
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('is inactive once the resource no longer lists the client', async () => {
    const token = await minted();
    expect((await introspect(token)).body.active).toBe(true);
    process.env.OAUTH_EXCHANGE_RESOURCES = registry(null);
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('is inactive once the client holds any grant besides the service grant', async () => {
    const token = await minted();
    expect((await introspect(token)).body.active).toBe(true);
    serviceRow().grants = [SERVICE_GRANT, 'client_credentials'];
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('is inactive once its record is gone or no longer matches the token', async () => {
    const token = await minted();
    expect((await introspect(token)).body.active).toBe(true);
    const [[key, stored]] = [...h.redis.entries()];
    const original = JSON.parse(stored.value) as Row;
    for (const change of [{ kind: 'exchange' }, { clientId: APP }, { resource: OTHER_RESOURCE }]) {
      h.redis.set(key, { ...stored, value: JSON.stringify({ ...original, ...change }) });
      expect((await introspect(token)).body, JSON.stringify(change)).toEqual({ active: false });
    }
    h.redis.clear();
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('keeps a scope narrowed at mint narrowed at introspection', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({
      scopes: ['AIServicesRead', 'AIServicesWrite'],
    });
    const token = await minted({ scope: 'AIServicesRead' });
    expect((await introspect(token)).body.scope).toBe('AIServicesRead');
  });

  it("narrows scope to the entry's current scopes, inactive when none are left", async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({
      scopes: ['AIServicesRead', 'AIServicesWrite'],
    });
    const token = await minted();
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ scopes: ['AIServicesRead'] });
    expect((await introspect(token)).body.scope).toBe('AIServicesRead');
    process.env.OAUTH_EXCHANGE_RESOURCES = JSON.stringify([
      {
        resource: RESOURCE,
        scopes: ['AIServicesRead', 'AIServicesWrite', 'ModelsRead'],
        apps: [APP],
        introspectors: [INTROSPECTOR],
        services: [{ client: SERVICE, scopes: ['ModelsRead'], roles: [], uid: -1001 }],
      },
    ]);
    expect((await introspect(token)).body).toEqual({ active: false });
  });

  it('answers 503 when the client lookup fails', async () => {
    const token = await minted();
    h.dbThrows = (table, where) =>
      table === 'OauthClient' && where.some(([, , value]) => value === SERVICE);
    const res = await introspect(token);
    expect(res.status).toBe(503);
  });
});

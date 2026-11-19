import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisModule from '$lib/server/redis';
import type * as RequestModule from '$lib/server/auth/request';

// A service's own token exchanged by relays (token route → client-exchange.ts), hop by hop, on the same
// fakes as user-exchange.test.ts and service-token.test.ts: the db fake filters on the where clauses it is
// given. Every refusal asserts the reason it was refused for, so it is the named check that fired.

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
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST as tokenPOST } from '../../../../routes/api/auth/oauth/token/+server';
import { parseExchangeResources } from '../exchange-resources';
import { writeExchangeRecord } from '../token-exchange';
import { getSigner } from '../user-exchange';
import { ACCESS_TOKEN_TYPE, SERVICE_GRANT, TOKEN_EXCHANGE_GRANT } from '../constants';

// The chain an index consumer reads through: its own token for the gateway, which the gateway exchanges
// for the experimental registry, which exchanges it for the apps origin. Ids pairwise distinct.
const GATEWAY_RES = 'https://gateway.test';
const EXP_RES = 'https://registry-exp.test';
const APPS_RES = 'https://apps.test';
const INDEX = '3c9e1a7b-5d2f-4e8a-b6c4-0f1e2d3c4b5a'; // the index consumer, a service client
const OTHER_SERVICE = '8a4f2c6e-0b1d-4c3e-9f5a-7d6e5c4b3a29';
const GATEWAY = 'relay-gateway';
const EXP_SERVER = 'registry-exp-server';
const STRANGER_RELAY = 'relay-stranger';
const APP = 'app-explorer';
const SECRET = 'client-secret-value';
const USER_ID = 42;
const SUBJECT = 'civitai_subject-token-value';

function client(id: string, over: Row = {}): Row {
  return {
    id,
    secret: generateSecretHash(SECRET),
    isConfidential: true,
    tokenRateLimit: null,
    userId: 1,
    accessMode: 'open',
    grants: ['authorization_code', 'refresh_token'],
    allowedScopes: TokenScope.AppsRead | TokenScope.AppDataRead | TokenScope.UserRead,
    ...over,
  };
}
const serviceClient = (id: string, over: Row = {}) =>
  client(id, { userId: -1, grants: [SERVICE_GRANT], allowedScopes: TokenScope.UserRead, ...over });

/** The registry, with `subjects` as serviceSubjects of every resource but the first (null: left out). */
function registry(subjects: string[] | null = [INDEX]) {
  const withSubjects = subjects === null ? {} : { serviceSubjects: subjects };
  return JSON.stringify([
    {
      resource: GATEWAY_RES,
      scopes: ['AppsRead', 'AppDataRead'],
      apps: [APP],
      introspectors: [GATEWAY],
      services: [{ client: INDEX, scopes: ['AppsRead', 'AppDataRead'], uid: -1101 }],
    },
    {
      resource: EXP_RES,
      scopes: ['AppsRead', 'AppDataRead'],
      apps: [APP],
      relays: [GATEWAY],
      introspectors: [EXP_SERVER],
      services: [{ client: OTHER_SERVICE, scopes: ['AppsRead'], uid: -1102 }],
      ...withSubjects,
    },
    {
      resource: APPS_RES,
      scopes: ['AppsRead'],
      apps: [APP],
      relays: [EXP_SERVER, STRANGER_RELAY],
      ...withSubjects,
    },
  ]);
}

beforeEach(() => {
  h.tables = {
    OauthClient: [
      serviceClient(INDEX),
      serviceClient(OTHER_SERVICE),
      client(GATEWAY),
      client(EXP_SERVER),
      client(STRANGER_RELAY),
      client(APP),
    ],
    ApiKey: [
      {
        id: 7,
        key: generateSecretHash(SUBJECT),
        name: `oauth:${APP}`,
        userId: USER_ID,
        clientId: APP,
        tokenScope: TokenScope.AppsRead | TokenScope.UserRead,
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

const basic = (id: string) => `Basic ${Buffer.from(`${id}:${SECRET}`).toString('base64')}`;

async function post(form: URLSearchParams, caller: string) {
  const request = new Request('https://auth.test/api/auth/oauth/token', {
    method: 'POST',
    body: form,
    headers: { authorization: basic(caller) },
  });
  const res = await tokenPOST({ request } as never);
  return { status: res.status, body: (await res.json()) as Row };
}

/** The index's own token for `resource` (client_credentials, service-token.ts). */
async function serviceToken(resource = GATEWAY_RES, caller = INDEX): Promise<string> {
  const res = await post(
    new URLSearchParams({ grant_type: 'client_credentials', resource }),
    caller
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

/** `caller` exchanges `subject` for `resource`. */
function exchange(subject: string, resource: string, caller: string, extra: Row = {}) {
  return post(
    new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subject,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource,
      ...(extra as Record<string, string>),
    }),
    caller
  );
}

/** Hop 1: the gateway exchanges the index's token for the experimental registry. */
async function hop1(): Promise<string> {
  const res = await exchange(await serviceToken(), EXP_RES, GATEWAY);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.access_token as string;
}

const refusedFor = () =>
  h.logs.filter((l) => l.event === 'client_token_exchange' && l.result === 'refused');

function expectRefused(res: { status: number; body: Row }, error: string, reason: string) {
  expect(res.status).toBe(error === 'invalid_client' ? 401 : 400);
  expect(res.body).toEqual({ error, error_description: expect.any(String) });
  expect(res.body).not.toHaveProperty('access_token');
  // The named check fired, not an earlier one with the same error.
  expect(refusedFor().at(-1)).toMatchObject({ error, reason });
}

describe('🔴 client token exchange — an allowlisted service, on both hops', () => {
  it('hop 1 then hop 2: a token for the apps origin naming the service, no user, and the last relay', async () => {
    const forExp = await hop1();
    expect(decodeJwt(forExp)).toMatchObject({
      sub: INDEX,
      client_id: INDEX,
      aud: EXP_RES,
      act: { sub: GATEWAY },
    });

    const res = await exchange(forExp, APPS_RES, EXP_SERVER);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      access_token: expect.any(String),
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: expect.any(Number),
      scope: 'AppsRead',
    });
    const token = res.body.access_token as string;
    expect(decodeProtectedHeader(token).typ).toBe('at+jwt');
    const claims = decodeJwt(token);
    // The documented claims, and nothing else: no user, no roles, no civitai_uid.
    expect(Object.keys(claims).sort()).toEqual(
      ['act', 'aud', 'client_id', 'exp', 'iat', 'iss', 'jti', 'scope', 'sub'].sort()
    );
    expect(claims).toMatchObject({
      iss: 'https://auth.test',
      sub: INDEX,
      client_id: INDEX,
      aud: APPS_RES,
      scope: 'AppsRead', // the subject's AppsRead AppDataRead within the origin's AppsRead cap
      act: { sub: EXP_SERVER },
    });
    // Never past the token it came from.
    expect(claims.exp!).toBeLessThanOrEqual(decodeJwt(forExp).exp!);
  });

  it('the index’s own token for the experimental registry is exchanged straight to the origin', async () => {
    const res = await exchange(
      await serviceToken(EXP_RES, INDEX).catch(() => ''),
      APPS_RES,
      EXP_SERVER
    );
    // INDEX is not a service of EXP_RES: it cannot get that token, so this is the one-hop shape via
    // OTHER_SERVICE, which the origin does not list.
    expect(res.status).toBe(400);
    const own = await serviceToken(EXP_RES, OTHER_SERVICE);
    expectRefused(
      await exchange(own, APPS_RES, EXP_SERVER),
      'unauthorized_client',
      'service not a subject of resource'
    );
    process.env.OAUTH_EXCHANGE_RESOURCES = registry([INDEX, OTHER_SERVICE]);
    const listed = await exchange(own, APPS_RES, EXP_SERVER);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(decodeJwt(listed.body.access_token as string)).toMatchObject({
      sub: OTHER_SERVICE,
      client_id: OTHER_SERVICE,
      act: { sub: EXP_SERVER },
    });
  });
});

describe('🔴 client token exchange — refused unless allowed', () => {
  it('default (no serviceSubjects anywhere): refused on hop 1 and on hop 2', async () => {
    const forExp = await hop1();
    process.env.OAUTH_EXCHANGE_RESOURCES = registry(null);
    expectRefused(
      await exchange(await serviceToken(), EXP_RES, GATEWAY),
      'unauthorized_client',
      'service not a subject of resource'
    );
    expectRefused(
      await exchange(forExp, APPS_RES, EXP_SERVER),
      'unauthorized_client',
      'service not a subject of resource'
    );
  });

  it('a service the target does not list is refused; the listed one is not', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry([OTHER_SERVICE]);
    expectRefused(
      await exchange(await serviceToken(), EXP_RES, GATEWAY),
      'unauthorized_client',
      'service not a subject of resource'
    );
    process.env.OAUTH_EXCHANGE_RESOURCES = registry([INDEX]);
    expect((await exchange(await serviceToken(), EXP_RES, GATEWAY)).status).toBe(200);
  });

  it('🔴 a USER token, as a JWT, is never a subject here, whoever lists whom', async () => {
    // The user's opaque token exchanged (user path) for the experimental registry, by the app.
    const userJwt = await post(
      new URLSearchParams({
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: SUBJECT,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: EXP_RES,
      }),
      APP
    );
    expect(userJwt.status, JSON.stringify(userJwt.body)).toBe(200);
    const token = userJwt.body.access_token as string;
    expect(decodeJwt(token)).toMatchObject({ sub: String(USER_ID), client_id: APP });
    expectRefused(
      await exchange(token, APPS_RES, EXP_SERVER),
      'invalid_grant',
      'subject is not a service token'
    );
  });

  it('a token whose sub is its client_id but not a service client id is refused', async () => {
    // Signed by the hub and recorded like a service token, for a client id of a user app's shape.
    const iat = Math.floor(Date.now() / 1000);
    const jti = `not-a-service-${iat}`;
    const token = await getSigner()!.mintAccessTokenJwt({
      iss: 'https://auth.test',
      sub: APP,
      aud: EXP_RES,
      client_id: APP,
      scope: 'AppsRead',
      jti,
      iat,
      exp: iat + 600,
    });
    await writeExchangeRecord(
      jti,
      {
        kind: 'service',
        clientId: APP,
        resource: EXP_RES,
        scopeBits: TokenScope.AppsRead,
        exp: iat + 600,
      },
      iat
    );
    process.env.OAUTH_EXCHANGE_RESOURCES = registry([INDEX]);
    expectRefused(
      await exchange(token, APPS_RES, EXP_SERVER),
      'invalid_grant',
      'subject is not a service token'
    );
  });

  it('a caller that is not a relay of the target is refused', async () => {
    const forExp = await hop1();
    expectRefused(
      await exchange(forExp, APPS_RES, GATEWAY),
      'unauthorized_client',
      'caller not a relay of resource'
    );
  });

  it('a relay of the target that does not serve the subject’s resource is refused', async () => {
    const forExp = await hop1();
    expectRefused(
      await exchange(forExp, APPS_RES, STRANGER_RELAY),
      'unauthorized_client',
      'caller does not serve the subject resource'
    );
  });

  it('a subject the hub holds no record of is refused', async () => {
    const forExp = await hop1();
    h.redis.clear();
    expectRefused(
      await exchange(forExp, APPS_RES, EXP_SERVER),
      'invalid_grant',
      'no matching subject record'
    );
  });

  it('a disabled service client is refused', async () => {
    const forExp = await hop1();
    h.tables.OauthClient.find((c) => c.id === INDEX)!.accessMode = 'disabled';
    expectRefused(
      await exchange(forExp, APPS_RES, EXP_SERVER),
      'unauthorized_client',
      'service not active'
    );
  });
});

/**
 * A service token for EXP_RES as the hub would hold it, but with an expiry this test picks: signed with
 * the hub's key and recorded, so only `exp` differs from one the service-token grant mints.
 */
async function serviceSubjectExpiring(inSeconds: number): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + inSeconds;
  const jti = `sub-${inSeconds}-${iat}`;
  const token = await getSigner()!.mintAccessTokenJwt({
    iss: 'https://auth.test',
    sub: INDEX,
    aud: EXP_RES,
    client_id: INDEX,
    scope: 'AppsRead',
    jti,
    iat,
    exp,
  });
  await writeExchangeRecord(
    jti,
    { kind: 'service', clientId: INDEX, resource: EXP_RES, scopeBits: TokenScope.AppsRead, exp },
    iat
  );
  return { token, exp };
}

describe('🔴 client token exchange — expiry', () => {
  it('never outlives the subject: a subject with 2 minutes left gives a token with 2 minutes', async () => {
    const subject = await serviceSubjectExpiring(120);
    const res = await exchange(subject.token, APPS_RES, EXP_SERVER);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const claims = decodeJwt(res.body.access_token as string);
    expect(claims.exp).toBe(subject.exp);
    expect(res.body.expires_in).toBeLessThanOrEqual(120);
  });

  it('never exceeds the 15-minute cap: a subject with an hour left gives a token with 15 minutes', async () => {
    const subject = await serviceSubjectExpiring(3600);
    const res = await exchange(subject.token, APPS_RES, EXP_SERVER);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const claims = decodeJwt(res.body.access_token as string);
    expect(claims.exp! - claims.iat!).toBe(15 * 60);
    expect(claims.exp!).toBeLessThan(subject.exp);
    expect(res.body.expires_in).toBe(15 * 60);
  });
});

describe('🔴 client token exchange — the log line', () => {
  it('records the service, the relay and the resource (and the subject resource), never a token', async () => {
    const forExp = await hop1();
    h.logs = [];
    const res = await exchange(forExp, APPS_RES, EXP_SERVER);
    expect(res.status).toBe(200);
    const issued = h.logs.filter((l) => l.event === 'client_token_exchange');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      result: 'issued',
      service: INDEX,
      relay: EXP_SERVER,
      resource: APPS_RES,
      source: EXP_RES,
    });
    const line = JSON.stringify(issued[0]);
    expect(line).not.toContain(forExp);
    expect(line).not.toContain(res.body.access_token as string);
    // A refusal names them too.
    process.env.OAUTH_EXCHANGE_RESOURCES = registry(null);
    h.logs = [];
    await exchange(forExp, APPS_RES, EXP_SERVER);
    expect(refusedFor().at(-1)).toMatchObject({
      service: INDEX,
      relay: EXP_SERVER,
      resource: APPS_RES,
      reason: 'service not a subject of resource',
    });
  });
});

describe('🔴 the user exchange is unchanged', () => {
  it('a user’s opaque token still takes the user path and mints the user format, allowlist or not', async () => {
    for (const subjects of [null, [INDEX]]) {
      process.env.OAUTH_EXCHANGE_RESOURCES = registry(subjects);
      h.logs = [];
      const res = await post(
        new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: SUBJECT,
          subject_token_type: ACCESS_TOKEN_TYPE,
          resource: APPS_RES,
        }),
        APP
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const claims = decodeJwt(res.body.access_token as string);
      expect(Object.keys(claims).sort()).toEqual(
        ['aud', 'client_id', 'exp', 'iat', 'iss', 'jti', 'scope', 'sub'].sort()
      );
      expect(claims).toMatchObject({
        sub: String(USER_ID),
        client_id: APP,
        aud: APPS_RES,
        scope: 'AppsRead',
      });
      // It went down the user exchange, never this one.
      expect(h.logs.some((l) => l.event === 'token_exchange' && l.result === 'issued')).toBe(true);
      expect(h.logs.some((l) => l.event === 'client_token_exchange')).toBe(false);
    }
  });
});

describe('serviceSubjects in OAUTH_EXCHANGE_RESOURCES', () => {
  const parse = (serviceSubjects: unknown) => {
    const parsed = parseExchangeResources(
      JSON.stringify([
        {
          resource: APPS_RES,
          scopes: ['AppsRead'],
          apps: [APP],
          relays: [EXP_SERVER],
          serviceSubjects,
        },
      ])
    );
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed;
  };

  it('is empty when left out', () => {
    expect(parse(undefined).resources[0].serviceSubjects).toEqual([]);
  });

  it('is empty when left out even for a resource with services: a service is not a subject by being one', () => {
    const parsed = parseExchangeResources(
      JSON.stringify([
        {
          resource: APPS_RES,
          scopes: ['AppsRead'],
          apps: [APP],
          relays: [EXP_SERVER],
          services: [{ client: INDEX, scopes: ['AppsRead'], uid: -1201 }],
        },
      ])
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.resources[0].services.map((x) => x.client)).toEqual([INDEX]);
    expect(parsed.resources[0].serviceSubjects).toEqual([]);
  });

  it('takes service client ids', () => {
    expect(parse([INDEX]).resources[0].serviceSubjects).toEqual([INDEX]);
  });

  it('drops a bad list (and only it): not a UUID, a repeat, or a user client', () => {
    for (const bad of [['not-a-uuid'], [INDEX, INDEX], [EXP_SERVER], 'x']) {
      const parsed = parse(bad);
      expect(parsed.resources[0].serviceSubjects).toEqual([]);
      expect(parsed.resources).toHaveLength(1);
      expect(parsed.serviceErrors).toHaveLength(1);
      expect(parsed.serviceErrors[0]).toMatch(/serviceSubjects ignored/);
    }
  });
});

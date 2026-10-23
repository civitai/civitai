import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type * as CivitaiAuth from '@civitai/auth';
import type * as Jose from 'jose';

/**
 * The worker token exchange end to end through the real token, introspect and revoke routes, the OAuth
 * library and the hub model, over one in-memory database: a worker trades its device credential for a
 * 15-minute `Worker` token, introspection reads it as valid, and then as invalid once it expires, is
 * revoked, its device is blocked or its client is removed. Only the database, redis, the rate limiter, the
 * audit log and the remote JWKS fetch are stubbed. Every client secret is generated at runtime.
 */

const h = vi.hoisted(() => {
  // generateSecretHash salts with NEXTAUTH_SECRET, read once by @civitai/auth.
  process.env.NEXTAUTH_SECRET = `worker-exchange-test-${Math.random()}`;
  return {
    tables: {} as Record<string, Record<string, unknown>[]>,
    clientIp: '203.0.113.20' as string | null,
    rateLimitDeny: new Set<string>(),
    rateLimitCalls: [] as [string, string | null | undefined][],
    events: [] as Record<string, unknown>[],
    jwks: { keys: [] as Record<string, unknown>[] },
    jwksDown: false,
  };
});

vi.mock('$lib/server/db/db', async () => {
  const { createKyselyFake } = await import('../../../../../../test/kysely-fake');
  return {
    db: createKyselyFake(h.tables, {
      WorkerDevice: () => ({
        status: 'active',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        blockedAt: null,
        blockedReason: null,
      }),
    }),
  };
});
vi.mock('$lib/server/redis', () => ({ getRedis: () => null }));
vi.mock('@civitai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof CivitaiAuth>()),
  maybeCreateSessionSigner: () => undefined,
}));
vi.mock('$lib/server/oauth/rate-limit', () => ({
  checkOAuthRateLimit: vi.fn(async (bucket: string, id: string | null | undefined) => {
    h.rateLimitCalls.push([bucket, id]);
    return !h.rateLimitDeny.has(bucket);
  }),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({
  logOAuthEvent: vi.fn((e: Record<string, unknown>) => h.events.push(e)),
}));
vi.mock('$lib/server/axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));
vi.mock('$lib/server/auth/request', () => ({ getClientIp: () => h.clientIp }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof Jose>();
  return {
    ...actual,
    createRemoteJWKSet: () => {
      const local = actual.createLocalJWKSet(h.jwks as Jose.JSONWebKeySet);
      return (...args: Parameters<typeof local>) => {
        if (h.jwksDown) throw new Error('fetch failed');
        return local(...args);
      };
    },
  };
});

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { generateKey, generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { POST as TOKEN } from '../+server';
import { POST as INTROSPECT } from '../../introspect/+server';
import { POST as REVOKE } from '../../revoke/+server';
import { blockWorkerDevice } from '$lib/server/oauth/worker-admin';
import { db } from '$lib/server/db/db';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const DEVICE_ID_TYPE = 'urn:civitai:token-type:device-id';
const JWT_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
const WORKER = TokenScope.WorkerRegister;
const OWNER = 900;
const POOL = 'workers-dp';
const SALAD_POOL = 'workers-salad';
const OTHER_POOL = 'workers-other';
const ORCHESTRATOR = 'orchestrator';
const LINK = 'link-service';
const DEVICE = 'machine-0001';
const SALAD_GROUP = 'group-a';
const SALAD_ISSUER = 'https://salad.example';
const SALAD_AUDIENCE = 'https://auth.civitai.example/workers';

const secrets: Record<string, string> = {};
let saladKey: CryptoKey;
let strangerKey: CryptoKey;

function confidentialClient(id: string, over: Record<string, unknown> = {}) {
  secrets[id] = generateKey(64);
  return {
    id,
    secret: generateSecretHash(secrets[id]),
    name: id,
    isConfidential: true,
    grants: [GRANT],
    allowedScopes: WORKER,
    userId: OWNER,
    redirectUris: [],
    allowedOrigins: [],
    ...over,
  };
}

function form(path: string, body: Record<string, string>) {
  return new Request(`https://auth.civitai.com/api/auth/oauth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
}

async function exchange(
  over: Record<string, string> = {},
  { clientId = POOL }: { clientId?: string } = {}
) {
  const res = await TOKEN({
    request: form('token', {
      grant_type: GRANT,
      client_id: clientId,
      client_secret: secrets[clientId],
      subject_token: DEVICE,
      subject_token_type: DEVICE_ID_TYPE,
      ...over,
    }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function introspect(token: string, caller = ORCHESTRATOR) {
  const res = await INTROSPECT({
    request: form('introspect', { client_id: caller, client_secret: secrets[caller], token }),
  } as never);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

function saladExchange(subjectToken: string) {
  return exchange(
    { subject_token: subjectToken, subject_token_type: JWT_TYPE },
    { clientId: SALAD_POOL }
  );
}

async function revoke(token: string, clientId: string) {
  const res = await REVOKE({
    request: form('revoke', { token, client_id: clientId, client_secret: secrets[clientId] }),
    locals: {},
  } as never);
  expect(res.status).toBe(200);
}

function saladJwt(
  claims: Record<string, unknown> = {},
  key: CryptoKey = saladKey,
  {
    expires = true,
    issuer = SALAD_ISSUER,
    audience = SALAD_AUDIENCE,
  }: { expires?: boolean; issuer?: string; audience?: string } = {}
): Promise<string> {
  const jwt = new SignJWT({
    salad_machine_id: 'salad-machine-7',
    salad_container_group_id: SALAD_GROUP,
    ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'salad-1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt();
  return (expires ? jwt.setExpirationTime('5m') : jwt).sign(key);
}

const rows = (table: string) => h.tables[table] ?? [];
const workerKeys = () => rows('ApiKey').filter((r) => r.type === 'Worker');

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  saladKey = pair.privateKey;
  strangerKey = (await generateKeyPair('ES256')).privateKey;
  h.jwks.keys = [{ ...(await exportJWK(pair.publicKey)), kid: 'salad-1', alg: 'ES256' }];
});

beforeEach(() => {
  for (const key of Object.keys(h.tables)) delete h.tables[key];
  h.tables.OauthClient = [
    confidentialClient(POOL),
    confidentialClient(SALAD_POOL),
    confidentialClient(OTHER_POOL),
    confidentialClient(ORCHESTRATOR, { grants: ['client_credentials'], allowedScopes: 0 }),
    confidentialClient(LINK, { grants: ['client_credentials'], allowedScopes: 0 }),
  ];
  h.tables.WorkerClient = [
    {
      clientId: POOL,
      provider: 'dp',
      subjectTokenTypes: [DEVICE_ID_TYPE],
      saladContainerGroupIds: [],
    },
    {
      clientId: SALAD_POOL,
      provider: 'salad',
      subjectTokenTypes: [JWT_TYPE],
      saladContainerGroupIds: [SALAD_GROUP],
    },
    {
      clientId: OTHER_POOL,
      provider: 'dp-other',
      subjectTokenTypes: [DEVICE_ID_TYPE],
      saladContainerGroupIds: [],
    },
  ];
  h.tables.User = [{ id: 501, username: 'link-user', deletedAt: null, bannedAt: null }];
  h.tables.ApiKey = [];
  h.tables.WorkerDevice = [];
  h.clientIp = '203.0.113.20';
  h.rateLimitDeny.clear();
  h.rateLimitCalls.length = 0;
  h.events.length = 0;
  h.jwksDown = false;
  process.env.OAUTH_WORKER_INTROSPECTION_CLIENT_IDS = ORCHESTRATOR;
  process.env.OAUTH_INTROSPECTION_CLIENT_IDS = LINK;
  process.env.WORKER_SALAD_JWT_ENABLED = '';
  process.env.WORKER_SALAD_JWKS_URL = 'https://salad.example/jwks.json';
  process.env.WORKER_SALAD_JWT_ISSUER = SALAD_ISSUER;
  process.env.WORKER_SALAD_JWT_AUDIENCE = SALAD_AUDIENCE;
  process.env.WORKER_SALAD_JWT_ALGORITHMS = 'ES256';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('worker token exchange', () => {
  it('issues a 900 s Bearer token carrying only WorkerRegister, with no refresh token', async () => {
    const res = await exchange();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      access_token: expect.stringMatching(/^civitai_/),
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer',
      expires_in: 900,
      scope: String(WORKER),
    });
    const [device] = rows('WorkerDevice');
    expect(device).toMatchObject({
      clientId: POOL,
      issuer: 'self',
      subject: DEVICE,
      lastIp: '203.0.113.20',
    });
    expect(workerKeys()).toEqual([
      expect.objectContaining({
        key: generateSecretHash(res.body.access_token as string),
        type: 'Worker',
        tokenScope: WORKER,
        userId: OWNER,
        clientId: POOL,
        workerDeviceId: device.id,
        expiresAt: new Date('2026-10-23T12:15:00.000Z'),
      }),
    ]);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: 'worker.token.issued',
        clientId: POOL,
        ip: '203.0.113.20',
        metadata: { workerDeviceId: device.id, issuer: 'self', deviceId: DEVICE },
      }),
    ]);
  });

  it('records a returning device on its existing row', async () => {
    await exchange();
    vi.setSystemTime(new Date('2026-10-23T12:14:00.000Z'));
    h.clientIp = '203.0.113.21';
    await exchange();

    expect(rows('WorkerDevice')).toHaveLength(1);
    expect(rows('WorkerDevice')[0]).toMatchObject({
      lastSeenAt: new Date('2026-10-23T12:14:00.000Z'),
      lastIp: '203.0.113.21',
    });
    expect(workerKeys()).toHaveLength(2);
  });

  it('charges the per-IP worker bucket before auth, not the shared token bucket', async () => {
    await exchange();
    expect(h.rateLimitCalls).toEqual([
      ['worker-token', '203.0.113.20'],
      ['worker-device', `${POOL}:self:${DEVICE}`],
    ]);
  });

  it('answers 429 when the device is over its limit, and issues nothing', async () => {
    h.rateLimitDeny.add('worker-device');
    const res = await exchange();
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a wrong client secret', async () => {
    const res = await exchange({ client_secret: generateKey(64) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(rows('WorkerDevice')).toHaveLength(0);
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a blocked device', async () => {
    await exchange();
    await blockWorkerDevice(db as never, rows('WorkerDevice')[0].id as number, 'test');

    const res = await exchange();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a client holding the grant that is not a workload client', async () => {
    h.tables.WorkerClient = h.tables.WorkerClient.filter((r) => r.clientId !== POOL);
    const res = await exchange();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a workload client that is not confidential, whatever secret it sends', async () => {
    h.tables.OauthClient.find((c) => c.id === POOL)!.isConfidential = false;
    const res = await exchange({ client_secret: 'anything' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(workerKeys()).toHaveLength(0);
  });

  it("clears the device's expired tokens on its next exchange, and no one else's", async () => {
    await exchange();
    await exchange({ subject_token: 'machine-other' });
    vi.setSystemTime(new Date('2026-10-23T12:16:00.000Z'));
    const res = await exchange();

    expect(workerKeys()).toEqual([
      expect.objectContaining({ workerDeviceId: rows('WorkerDevice')[1].id }),
      expect.objectContaining({ key: generateSecretHash(res.body.access_token as string) }),
    ]);
  });

  it('refuses a workload client whose ceiling lacks WorkerRegister', async () => {
    h.tables.OauthClient.find((c) => c.id === POOL)!.allowedScopes = TokenScope.UserRead;
    const res = await exchange();
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
  });

  it('refuses a client without the token-exchange grant', async () => {
    const res = await exchange({}, { clientId: ORCHESTRATOR });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a malformed device id', async () => {
    expect((await exchange({ subject_token: 'has spaces' })).body.error).toBe('invalid_request');
    expect((await exchange({ subject_token: 'x'.repeat(129) })).body.error).toBe('invalid_request');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a subject token type the client does not accept', async () => {
    process.env.WORKER_SALAD_JWT_ENABLED = 'true';
    expect((await exchange({ subject_token_type: 'urn:other' })).body.error).toBe('invalid_grant');
    const jwt = await saladJwt();
    const res = await exchange({ subject_token: jwt, subject_token_type: JWT_TYPE });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a device id from a Salad pool client', async () => {
    const res = await exchange({}, { clientId: SALAD_POOL });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');

    // Also when the client's accepted types list device ids by mistake.
    const salad = h.tables.WorkerClient.find((c) => c.clientId === SALAD_POOL)!;
    salad.subjectTokenTypes = [JWT_TYPE, DEVICE_ID_TYPE];
    expect((await exchange({}, { clientId: SALAD_POOL })).body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('clears tokens left for a blocked device when it next tries to exchange', async () => {
    await exchange();
    // A token written by an exchange that raced the block.
    rows('WorkerDevice')[0].status = 'blocked';
    expect(workerKeys()).toHaveLength(1);

    const res = await exchange();
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses any requested scope other than WorkerRegister', async () => {
    const res = await exchange({ scope: String(WORKER | TokenScope.UserRead) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect((await exchange({ scope: String(WORKER) })).status).toBe(200);
  });
});

describe('worker token exchange — Salad IMDS JWT', () => {
  beforeEach(() => {
    process.env.WORKER_SALAD_JWT_ENABLED = 'true';
  });

  it('accepts a token signed by the Salad key for an allowed group', async () => {
    const res = await saladExchange(await saladJwt());
    expect(res.status).toBe(200);
    expect(rows('WorkerDevice')[0]).toMatchObject({ issuer: 'salad', subject: 'salad-machine-7' });
  });

  it('refuses it while the flag is off', async () => {
    process.env.WORKER_SALAD_JWT_ENABLED = '';
    const res = await saladExchange(await saladJwt());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a token with a bad signature', async () => {
    const res = await saladExchange(await saladJwt({}, strangerKey));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a token without an expiry', async () => {
    const res = await saladExchange(await saladJwt({}, saladKey, { expires: false }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('answers a server error, not invalid_grant, when the JWKS cannot be fetched', async () => {
    h.jwksDown = true;
    const res = await saladExchange(await saladJwt());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('server_error');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a container group not on the client allowlist', async () => {
    const res = await saladExchange(await saladJwt({ salad_container_group_id: 'group-b' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it.each([
    'WORKER_SALAD_JWKS_URL',
    'WORKER_SALAD_JWT_ISSUER',
    'WORKER_SALAD_JWT_AUDIENCE',
    'WORKER_SALAD_JWT_ALGORITHMS',
  ])('is off while %s is unset, whatever the flag says', async (name) => {
    process.env[name] = '';
    const res = await saladExchange(await saladJwt());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a token for another audience or from another issuer', async () => {
    const otherAudience = await saladJwt({}, saladKey, { audience: 'https://elsewhere.example' });
    expect((await saladExchange(otherAudience)).body.error).toBe('invalid_grant');
    const otherIssuer = await saladJwt({}, saladKey, { issuer: 'https://not-salad.example' });
    expect((await saladExchange(otherIssuer)).body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a token signed with an algorithm outside the configured list', async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const claims = {
      salad_machine_id: 'm1',
      salad_container_group_id: SALAD_GROUP,
      iss: SALAD_ISSUER,
      aud: SALAD_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const none = `${enc({ alg: 'none', kid: 'salad-1' })}.${enc(claims)}.`;
    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'salad-1' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    expect((await saladExchange(none)).body.error).toBe('invalid_grant');
    expect((await saladExchange(hs256)).body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a valid token whose algorithm the config does not list', async () => {
    process.env.WORKER_SALAD_JWT_ALGORITHMS = 'RS256';
    const res = await saladExchange(await saladJwt());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(workerKeys()).toHaveLength(0);
  });

  it('refuses a machine id that is not a valid device id', async () => {
    const res = await saladExchange(await saladJwt({ salad_machine_id: 'x'.repeat(129) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(rows('WorkerDevice')).toHaveLength(0);
  });
});

describe('worker token introspection', () => {
  async function issue() {
    const res = await exchange();
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  it('reads a fresh token as active, with its provider and device and no user', async () => {
    const token = await issue();
    expect(await introspect(token)).toEqual({
      active: true,
      client_id: POOL,
      worker_provider: 'dp',
      device_id: DEVICE,
      device_issuer: 'self',
      scope: String(WORKER),
      exp: Math.floor(new Date('2026-10-23T12:15:00.000Z').getTime() / 1000),
      token_type: 'Bearer',
    });
  });

  it('reads it as inactive once it expires', async () => {
    const token = await issue();
    vi.setSystemTime(new Date('2026-10-23T12:14:59.000Z'));
    expect((await introspect(token)).active).toBe(true);
    vi.setSystemTime(new Date('2026-10-23T12:15:01.000Z'));
    expect(await introspect(token)).toEqual({ active: false });
  });

  it('reads it as inactive after its own client revokes it', async () => {
    const token = await issue();
    await revoke(token, POOL);
    expect(await introspect(token)).toEqual({ active: false });
    expect(workerKeys()).toHaveLength(0);
  });

  it('reads it as inactive after its client revokes it with HTTP Basic credentials', async () => {
    const token = await issue();
    const basic = Buffer.from(`${POOL}:${secrets[POOL]}`).toString('base64');
    const res = await REVOKE({
      request: new Request('https://auth.civitai.com/api/auth/oauth/revoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({ token }),
      }),
      locals: {},
    } as never);
    expect(res.status).toBe(200);
    expect(await introspect(token)).toEqual({ active: false });
  });

  it('ignores a revoke from another workload client with the same owner', async () => {
    const token = await issue();
    await revoke(token, OTHER_POOL);
    expect((await introspect(token)).active).toBe(true);
  });

  it('reads it as inactive after its device is blocked', async () => {
    const token = await issue();
    const deviceId = rows('WorkerDevice')[0].id as number;
    expect(await blockWorkerDevice(db as never, deviceId, 'test')).toEqual({ tokensDeleted: 1 });
    expect(await introspect(token)).toEqual({ active: false });
  });

  it('reads it as inactive for a blocked device even while the row survives', async () => {
    const token = await issue();
    rows('WorkerDevice')[0].status = 'blocked';
    expect(await introspect(token)).toEqual({ active: false });
  });

  it('reads it as inactive once its client is no longer a workload client', async () => {
    const token = await issue();
    h.tables.WorkerClient = [];
    expect(await introspect(token)).toEqual({ active: false });
  });

  it('reads it as inactive for an introspector not on the worker allowlist', async () => {
    const token = await issue();
    expect(await introspect(token, LINK)).toEqual({ active: false });
  });

  it('keeps user access tokens for the user allowlist only', async () => {
    const access = generateKey(36);
    h.tables.ApiKey.push({
      id: 77,
      key: generateSecretHash(access),
      type: 'Access',
      userId: 501,
      tokenScope: TokenScope.UserRead,
      clientId: 'some-app',
      expiresAt: new Date('2026-10-23T13:00:00.000Z'),
    });
    expect(await introspect(access, LINK)).toMatchObject({ active: true, username: 'link-user' });
    expect(await introspect(access, ORCHESTRATOR)).toEqual({ active: false });
  });

  it('refuses an introspector on neither allowlist', async () => {
    process.env.OAUTH_WORKER_INTROSPECTION_CLIENT_IDS = '';
    const res = await INTROSPECT({
      request: form('introspect', {
        client_id: ORCHESTRATOR,
        client_secret: secrets[ORCHESTRATOR],
        token: 'x',
      }),
    } as never);
    expect(res.status).toBe(401);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type * as RedisModule from '$lib/server/redis';
import type * as RequestModule from '$lib/server/auth/request';

// The block token exchange (token route → block-exchange.ts), end to end through the token route. Each
// refusal starts from the request the "issues" test proves is accepted and changes ONE thing, so a refusal
// test fails (status 200, or a different reason) if the guard it names is removed. Expected values are
// literals, never read back from the code under test.

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
  const kidOf = (pem: string) => {
    const jwk = createPublicKey(pem).export({ format: 'jwk' }) as { n?: string };
    return createHash('sha256')
      .update(jwk.n ?? '')
      .digest('hex')
      .slice(0, 32);
  };
  process.env.NEXTAUTH_SECRET = 'block-exchange-test-secret';
  process.env.CIVITAI_MODERATION_USER_ID = '999';
  return {
    site,
    forger,
    siteKid: kidOf(site.publicKey),
    forgerKid: kidOf(forger.publicKey),
    tables: {} as Record<string, Record<string, unknown>[]>,
    cache: new Map<string, string>(),
    redisNull: false,
    rate: new Map<string, number>(),
    clientIp: '203.0.113.7' as string | null,
    events: [] as Record<string, unknown>[],
    suspended: false,
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

vi.mock('$lib/server/db/db', () => {
  const db = {
    selectFrom(table: string) {
      const where: [string, string, unknown][] = [];
      const run = () => (h.tables[table] ?? []).filter((r) => where.every((w) => matches(r, w)));
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
    insertInto(table: string) {
      return {
        values: (values: Row) => ({
          execute: async () => {
            (h.tables[table] ??= []).push(values);
          },
        }),
      };
    },
    transaction() {
      return { execute: async <T>(fn: (trx: unknown) => Promise<T>) => fn(db) };
    },
  };
  return { db };
});

vi.mock('$lib/server/oauth/app-block-mint-lock', () => ({
  lockAppBlockSuspended: async () => h.suspended,
}));

vi.mock('$lib/server/redis', async (orig) => ({
  ...(await orig<typeof RedisModule>()),
  getRedis: () =>
    h.redisNull
      ? null
      : {
          async set(key: string, value: string, opts?: { NX?: boolean }) {
            if (opts?.NX && h.cache.has(key)) return null;
            h.cache.set(key, value);
            return 'OK';
          },
          async get(key: string) {
            return h.cache.get(key) ?? null;
          },
        },
  getSysRedis: () => null,
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
  logToAxiom: async () => undefined,
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

import { SignJWT, importPKCS8 } from 'jose';
import { TokenScope } from '@civitai/auth/token-scope';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { POST as tokenPOST } from '../../../../routes/api/auth/oauth/token/+server';
import { WorkerTokenExchangeGrant } from '../worker-grant';
import { invalidateRoleCache } from '../access';
import { parseBlockExchangeCallers } from '../block-exchange';

const NOW = 1_800_000_000; // a fixed second, so lifetimes are exact
const RESOURCE = 'https://apps.registry.test';
const APP = 'appblk-notes';
const RELAY = 'relay-app-data';
const OTHER_RELAY = 'relay-other';
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
    ApiKey: [],
    User: [{ id: USER_ID, username: 'alice', deletedAt: null, bannedAt: null, muted: false }],
    UserRole: [],
  };
  h.cache.clear();
  h.redisNull = false;
  h.rate.clear();
  h.clientIp = '203.0.113.7';
  h.events = [];
  h.suspended = false;
  invalidateRoleCache();
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
    ...over,
  };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: opts.kid ?? h.siteKid })
    .sign(await importPKCS8(opts.key ?? h.site.privateKey, 'RS256'));
}

const basic = (id: string, secret = SECRET) =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function exchange(subject: string, opts: { caller?: string; params?: Row } = {}) {
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
    headers: { authorization: basic(opts.caller ?? RELAY) },
  });
  const res = await tokenPOST({ request } as never);
  return { status: res.status, body: (await res.json()) as Row };
}

const refusals = () => h.events.filter((e) => e.type === 'block_exchange.refused');
const lastReason = () =>
  (refusals().at(-1)?.metadata as Row | undefined)?.reason as string | undefined;
const accessRows = () => h.tables.ApiKey.filter((r) => r.type === 'Access');

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
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses when the list is blank', async () => {
    process.env.OAUTH_BLOCK_EXCHANGE_CALLERS = ' , ';
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('caller allowlist empty');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses everyone when one listed id is malformed (the whole list is dropped)', async () => {
    process.env.OAUTH_BLOCK_EXCHANGE_CALLERS = `${RELAY}, bad/id`;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('caller allowlist empty');
    expect(h.tables.ApiKey).toEqual([]);
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
});

describe('block token exchange — the caller', () => {
  it('refuses an authenticated relay that is not on the allowlist', async () => {
    const res = await exchange(await blockToken(), { caller: OTHER_RELAY });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unauthorized_client');
    expect(lastReason()).toBe('caller not allowlisted');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses a caller with the wrong secret before the allowlist is consulted', async () => {
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: await blockToken(),
      subject_token_type: BLOCK_TOKEN_TYPE,
      resource: RESOURCE,
    });
    const request = new Request('https://auth.test/api/auth/oauth/token', {
      method: 'POST',
      body: form,
      headers: { authorization: basic(RELAY, 'wrong') },
    });
    const res = await tokenPOST({ request } as never);
    expect(res.status).toBe(401);
    expect(lastReason()).toBe('client authentication failed');
  });

  it('refuses an allowlisted caller that is not a relay of the resource', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ relays: [OTHER_RELAY] });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
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
  it('issues an opaque AppDataRead-only token for 15 minutes, with no refresh token', async () => {
    const res = await exchange(await blockToken());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'access_token',
      'expires_in',
      'issued_token_type',
      'scope',
      'token_type',
    ]);
    expect(res.body.scope).toBe('AppDataRead');
    expect(res.body.expires_in).toBe(900);
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.issued_token_type).toBe(ACCESS_TOKEN_TYPE);
    expect(res.body).not.toHaveProperty('refresh_token');
    // Opaque: the civitai_ prefix of every hub access token, not a JWT.
    expect(String(res.body.access_token)).toMatch(/^civitai_[^.]+$/);

    // The one row written: an Access token for (user, app) the site's bearer lookup reads as `oauth`.
    expect(h.tables.ApiKey).toHaveLength(1);
    const row = h.tables.ApiKey[0];
    expect(row.type).toBe('Access');
    expect(row.userId).toBe(42);
    expect(row.clientId).toBe('appblk-notes');
    expect(row.name).toBe('oauth-block:appblk-notes');
    expect(row.key).toBe(generateSecretHash(String(res.body.access_token)));
    // Exactly bit 32 (AppDataRead): no UserRead (bit 0), nothing the block token carried.
    expect(row.tokenScopeWide).toBe('4294967296');
    expect((row.expiresAt as Date).getTime()).toBe((NOW + 900) * 1000);
    expect(h.tables.ApiKey.filter((r) => r.type === 'Refresh')).toEqual([]);

    const issued = h.events.filter((e) => e.type === 'block_exchange.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      userId: 42,
      clientId: 'appblk-notes',
      metadata: { caller: 'relay-app-data', resource: RESOURCE, blockJti: expect.any(String) },
    });
  });

  it('issues AppDataRead only, whatever else the block token carries', async () => {
    const res = await exchange(
      await blockToken({
        scopes: ['apps:storage', 'apps:storage:publish', 'ai:write:budgeted', 'buzz:read:self'],
      })
    );
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('AppDataRead');
    expect(accessRows()[0].tokenScopeWide).toBe('4294967296');
  });

  it('never outlives the block token it came from', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 600, exp: NOW + 300 }));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(300);
    expect((accessRows()[0].expiresAt as Date).getTime()).toBe((NOW + 300) * 1000);
  });

  it('caps the token at 15 minutes even when the block token claims to live longer', async () => {
    // A block token whose exp overshoots the cap (a signer bug the age check alone would not catch).
    const res = await exchange(await blockToken({ iat: NOW, exp: NOW + 3600 }));
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(900);
    expect((accessRows()[0].expiresAt as Date).getTime()).toBe((NOW + 900) * 1000);
  });

  it('accepts scope=AppDataRead and refuses any other requested scope', async () => {
    const ok = await exchange(await blockToken(), { params: { scope: 'AppDataRead' } });
    expect(ok.status).toBe(200);
    const wider = await exchange(await blockToken(), { params: { scope: 'AppDataRead UserRead' } });
    expect(wider.status).toBe(400);
    expect(wider.body.error).toBe('invalid_scope');
    expect(lastReason()).toBe('scope must be AppDataRead');
    expect(accessRows()).toHaveLength(1);
  });
});

describe('block token exchange — the block token', () => {
  it('refuses a block token without the storage grant', async () => {
    const res = await exchange(
      await blockToken({ scopes: ['user:read:self', 'apps:storage:read'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token has no storage grant');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses an expired block token', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 1000, exp: NOW - 60 }));
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token signature or claims');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses a block token signed by another key under the site kid (forged)', async () => {
    const res = await exchange(await blockToken({}, { key: h.forger.privateKey }));
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token signature or claims');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses a block token whose kid the hub does not hold', async () => {
    const res = await exchange(
      await blockToken({}, { key: h.forger.privateKey, kid: h.forgerKid })
    );
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token unknown key');
  });

  it('refuses a block token for another audience', async () => {
    const res = await exchange(await blockToken({ aud: 'civitai-other' }));
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token signature or claims');
  });

  it('refuses an anonymous viewer', async () => {
    const res = await exchange(await blockToken({ sub: 'anon' }));
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token anonymous');
  });

  it('refuses dev and private-run tokens', async () => {
    await exchange(await blockToken({ dev: true }));
    expect(lastReason()).toBe('block token dev token');
    await exchange(await blockToken({ privateRun: true, privateRunAudience: 'owner' }));
    expect(lastReason()).toBe('block token private run');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('refuses a block token older than 15 minutes even if its exp is later', async () => {
    const res = await exchange(await blockToken({ iat: NOW - 931, exp: NOW + 600 }));
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('block token too old');
  });

  it('refuses every token when the hub holds no block-token key', async () => {
    delete process.env.BLOCK_TOKEN_PUBLIC_KEY;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(500);
    expect(lastReason()).toBe('block token keys not configured');
  });

  it('exchanges a block token once: a replay is refused', async () => {
    const token = await blockToken();
    expect((await exchange(token)).status).toBe(200);
    const replay = await exchange(token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(lastReason()).toBe('block token already exchanged');
    expect(accessRows()).toHaveLength(1);
  });

  it('refuses (fail closed) when the replay claim cannot be recorded', async () => {
    h.redisNull = true;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('temporarily_unavailable');
    expect(h.tables.ApiKey).toEqual([]);
  });
});

describe('block token exchange — the app and the viewer', () => {
  it('refuses an app the resource does not list', async () => {
    process.env.OAUTH_EXCHANGE_RESOURCES = registry({ apps: ['appblk-other'] });
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('app not listed for resource');
  });

  it('refuses an app that may not hold AppDataRead', async () => {
    h.tables.OauthClient[0].allowedScopes = TokenScope.AppsRead | TokenScope.UserRead;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('app may not hold AppDataRead');
  });

  it('refuses a banned viewer', async () => {
    h.tables.User[0].bannedAt = new Date(NOW * 1000);
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('user banned');
  });

  it('refuses while the app block is suspended', async () => {
    h.suspended = true;
    const res = await exchange(await blockToken());
    expect(res.status).toBe(400);
    expect(lastReason()).toBe('app block suspended');
    expect(h.tables.ApiKey).toEqual([]);
  });

  it('limits one (viewer, app) pair to 30 exchanges a minute', async () => {
    for (let i = 0; i < 30; i++) expect((await exchange(await blockToken())).status).toBe(200);
    const res = await exchange(await blockToken());
    expect(res.status).toBe(429);
    expect(lastReason()).toBe('user-app limit');
  });
});

describe('block token verification follows the site', () => {
  // The hub cannot import the site's modules, so its copies of the site's constants are pinned to the
  // site's source text: a change on either side fails here.
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../../../../../../${rel}`, import.meta.url)), 'utf8');

  it('uses the site issuer, audience and signed-in subject pattern', () => {
    const service = read('src/server/services/block-token.service.ts');
    expect(service).toContain("export const BLOCK_TOKEN_ISSUER = 'civitai';");
    expect(service).toContain("export const BLOCK_TOKEN_AUDIENCE = 'civitai-app-block';");
    const subject = read('src/server/services/block-token-subject.ts');
    expect(subject).toContain('export const USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;');
  });

  it('computes the kid as the site does', () => {
    const service = read('src/server/services/block-token.service.ts');
    expect(service).toContain("return createHash('sha256').update(n).digest('hex').slice(0, 32);");
  });
});

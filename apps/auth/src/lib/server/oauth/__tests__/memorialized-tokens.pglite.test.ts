import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import type * as OAuthRateLimit from '$lib/server/oauth/rate-limit';
import type * as Flipt from '$lib/server/flipt';

/**
 * No OAuth grant issues a token for a memorialized account, or for a client a memorialized account owns,
 * and its tokens stop reading as active. Each refusal is checked against the ApiKey rows Postgres holds
 * afterwards, next to an ordinary account that the same call does issue for.
 */

const h = vi.hoisted(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'pglite-test-secret');
  return {
    db: { current: null as unknown },
    deviceCode: undefined as unknown,
  };
});

vi.mock('$lib/server/db/db', () => ({
  get db() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
}));
vi.mock('$lib/server/redis', () => ({
  getRedis: () => ({ packed: { hGet: async () => h.deviceCode }, hDel: async () => 1 }),
  getSysRedis: () => null,
}));
vi.mock('$lib/server/oauth/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof OAuthRateLimit>()),
  checkOAuthRateLimit: async () => true,
}));
vi.mock('$lib/server/flipt', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isGlobalFlagOn: async () => false,
}));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
// userinfo's user, as a cache that predates the memorialization holds it.
vi.mock('$lib/server/auth/session-producer', () => ({
  getOrProduceSessionUser: async (id: number) => ({ id, username: `u${id}` }),
}));

const { oauthModel } = await import('../model');
const { createPlannedOAuthTokens, createAppAccessToken } = await import('../token-helpers');
const { deviceTokenGrant } = await import('../device-token');
const { userRefusal } = await import('../token-exchange');
const { scopeToString } = await import('../scope');
const { MemorializedAccountError } = await import('$lib/server/auth/account-refusal');
const { POST: introspect } = await import('../../../../routes/api/auth/oauth/introspect/+server');
const { GET: userinfo } = await import('../../../../routes/api/auth/oauth/userinfo/+server');

const MEMORIALIZED = 4;
const ACCOUNT = 6100;
const CLIENT = 'third-party-app';
const SYSTEM_OWNER = -1;

const PRELUDE = `
  CREATE TABLE "User" (
    "id" INTEGER PRIMARY KEY, "username" TEXT, "email" TEXT, "flags" INTEGER NOT NULL DEFAULT 0,
    "muted" BOOLEAN NOT NULL DEFAULT false, "bannedAt" TIMESTAMP, "deletedAt" TIMESTAMP
  );
  CREATE TABLE "ApiKey" (
    "id" SERIAL PRIMARY KEY, "key" TEXT NOT NULL, "name" TEXT, "tokenScope" INTEGER NOT NULL,
    "tokenScopeWide" TEXT, "userId" INTEGER, "type" TEXT, "expiresAt" TIMESTAMP, "clientId" TEXT,
    "mintOrigin" TEXT, "refreshFamilyId" TEXT
  );
  CREATE TABLE "UserRole" ("userId" INTEGER, "role" TEXT);
  CREATE TABLE "OauthClient" (
    "id" TEXT PRIMARY KEY, "userId" INTEGER, "grants" TEXT[] NOT NULL DEFAULT '{}',
    "isConfidential" BOOLEAN NOT NULL DEFAULT false, "secret" TEXT, "allowedScopes" TEXT NOT NULL DEFAULT '1',
    "skipConsent" BOOLEAN NOT NULL DEFAULT false, "accessMode" TEXT NOT NULL DEFAULT 'open'
  );
`;

let pg: PGlite;

function pgliteDialect(db: PGlite): Dialect {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await db.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not streamed');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

const seedUser = (flags: number, id = ACCOUNT) =>
  pg.query(`INSERT INTO "User" ("id", "username", "flags") VALUES ($1, $2, $3)`, [
    id,
    `u${id}`,
    flags,
  ]);
const keyCount = async () =>
  Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "ApiKey"`)).rows[0].n);

const scope = scopeToString(TokenScope.UserRead);
const client = { id: CLIENT, grants: ['authorization_code', 'refresh_token'] };
const saveToken = (user: Record<string, unknown>) =>
  oauthModel.saveToken({ scope } as never, client as never, user as never);

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
  h.deviceCode = undefined;
});

afterEach(async () => {
  h.db.current = null;
  await pg.close();
  delete process.env.CIVITAI_MODERATION_USER_ID;
  delete process.env.OAUTH_INTROSPECTION_CLIENT_IDS;
});

describe.each([
  ['authorization code', { id: ACCOUNT }],
  ['refresh', { id: ACCOUNT, viaRefresh: true }],
])('the %s grant', (_, user) => {
  it('issues for an ordinary account (positive control)', async () => {
    await seedUser(0);
    await expect(saveToken(user)).resolves.toMatchObject({ accessToken: expect.any(String) });
    expect(await keyCount()).toBe(2);
  });

  it('is invalid_grant for a memorialized account and writes no token', async () => {
    await seedUser(MEMORIALIZED);
    await expect(saveToken(user)).rejects.toMatchObject({ name: 'invalid_grant' });
    expect(await keyCount()).toBe(0);
  });
});

describe('the offline-grant mint', () => {
  const plan = { accessOrigin: 'authorization_code', refresh: null } as never;

  it('issues for an ordinary account and refuses a memorialized one, writing nothing', async () => {
    await seedUser(0);
    await createPlannedOAuthTokens(ACCOUNT, CLIENT, TokenScope.UserRead, plan);
    expect(await keyCount()).toBe(1);

    await pg.query(`UPDATE "User" SET "flags" = $1`, [MEMORIALIZED]);
    await expect(
      createPlannedOAuthTokens(ACCOUNT, CLIENT, TokenScope.UserRead, plan)
    ).rejects.toBeInstanceOf(MemorializedAccountError);
    expect(await keyCount()).toBe(1);
  });
});

describe('the client credentials grant', () => {
  const owner = (id: number) => ({ id, viaClientCredentials: true });

  it('issues for a client an ordinary account owns (positive control)', async () => {
    await seedUser(0);
    await expect(saveToken(owner(ACCOUNT))).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(await keyCount()).toBe(1);
  });

  it('is invalid_grant for a client a memorialized account owns, and writes no token', async () => {
    await seedUser(MEMORIALIZED);
    await expect(saveToken(owner(ACCOUNT))).rejects.toMatchObject({ name: 'invalid_grant' });
    expect(await keyCount()).toBe(0);
  });

  it('still issues for a client the system owner (-1) holds', async () => {
    await expect(saveToken(owner(SYSTEM_OWNER))).resolves.toMatchObject({
      accessToken: expect.any(String),
    });
    expect(await keyCount()).toBe(1);
  });

  it('refuses a client the moderation account owns', async () => {
    process.env.CIVITAI_MODERATION_USER_ID = String(ACCOUNT);
    await seedUser(0);
    await expect(saveToken(owner(ACCOUNT))).rejects.toMatchObject({ name: 'access_denied' });
    await expect(
      createAppAccessToken(ACCOUNT, CLIENT, TokenScope.UserRead, 60)
    ).rejects.toMatchObject({ status: 403 });
    expect(await keyCount()).toBe(0);
  });
});

describe('the device grant', () => {
  const poll = () =>
    deviceTokenGrant(new Request('https://auth.civitai.com/api/auth/oauth/device-token'), {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'devcode',
      client_id: CLIENT,
    });

  beforeEach(async () => {
    await pg.query(
      `INSERT INTO "OauthClient" ("id", "userId", "allowedScopes") VALUES ($1, 1, '1')`,
      [CLIENT]
    );
    h.deviceCode = {
      clientId: CLIENT,
      userCode: 'ABCD-EFGH',
      scope: String(TokenScope.UserRead),
      status: 'approved',
      userId: ACCOUNT,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  });

  it('issues for an ordinary account (positive control)', async () => {
    await seedUser(0);
    expect((await poll()).status).toBe(200);
    expect(await keyCount()).toBe(2);
  });

  it('is invalid_grant for a memorialized account and writes no token', async () => {
    await seedUser(MEMORIALIZED);
    const res = await poll();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await keyCount()).toBe(0);
  });
});

describe('the token exchange', () => {
  const app = { id: CLIENT, allowedScopes: TokenScope.UserRead, accessMode: 'public' };

  it('refuses a memorialized account as invalid_grant and allows an ordinary one', async () => {
    await seedUser(MEMORIALIZED);
    expect(await userRefusal(ACCOUNT, TokenScope.UserRead, app)).toEqual({
      reason: 'user memorialized',
      refusal: 'invalid_grant',
    });
    await pg.query(`UPDATE "User" SET "flags" = 0`);
    expect(await userRefusal(ACCOUNT, TokenScope.UserRead, app)).toBeNull();
  });
});

describe("a memorialized account's surviving access token", () => {
  const TOKEN = 'civitai_surviving_token';
  const SECRET = 'introspector-secret';

  beforeEach(async () => {
    await pg.query(
      `INSERT INTO "ApiKey" ("key", "name", "tokenScope", "userId", "type", "clientId") VALUES ($1, 'oauth:x', 1, $2, 'Access', $3)`,
      [generateSecretHash(TOKEN), ACCOUNT, CLIENT]
    );
    await pg.query(
      `INSERT INTO "OauthClient" ("id", "isConfidential", "secret") VALUES ('link-service', true, $1)`,
      [generateSecretHash(SECRET)]
    );
    process.env.OAUTH_INTROSPECTION_CLIENT_IDS = 'link-service';
  });

  const introspected = async () => {
    const res = await introspect({
      request: new Request('https://auth.civitai.com/api/auth/oauth/introspect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, client_id: 'link-service', client_secret: SECRET }),
      }),
    } as never);
    return ((await res.json()) as { active: boolean }).active;
  };
  const userinfoStatus = async () =>
    (
      await userinfo({
        request: new Request('https://auth.civitai.com/api/auth/oauth/userinfo', {
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      } as never)
    ).status;

  it('introspects as inactive and is refused by userinfo', async () => {
    await seedUser(MEMORIALIZED);
    expect(await introspected()).toBe(false);
    expect(await userinfoStatus()).toBe(401);
  });

  it('introspects as active and answers userinfo for an ordinary account (positive control)', async () => {
    await seedUser(0);
    expect(await introspected()).toBe(true);
    expect(await userinfoStatus()).toBe(200);
  });
});

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
import { TokenScope } from '@civitai/auth/token-scope';
import type * as Flipt from '$lib/server/flipt';

/**
 * The hub issues a recipe runner's scope (RunnerMint | UserRead, and nothing else) only on the
 * authorization-code and refresh grants of a runner client: Civitai-owned, confidential, consented,
 * open, no device flow, and bound to an app block. Each is re-read on every grant, and checked here
 * against the ApiKey rows Postgres holds afterwards.
 */

const h = vi.hoisted(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'pglite-test-secret');
  return { db: { current: null as unknown } };
});

vi.mock('$lib/server/db/db', () => ({
  get db() {
    if (!h.db.current) throw new Error('the pglite client was not installed for this test');
    return h.db.current;
  },
}));
vi.mock('$lib/server/redis', () => ({ getRedis: () => null, getSysRedis: () => null }));
vi.mock('$lib/server/flipt', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isGlobalFlagOn: async () => false,
}));
vi.mock('$lib/server/axiom', () => ({
  logToAxiom: vi.fn(async () => undefined),
  logAxiomError: vi.fn(),
}));
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));

const { oauthModel } = await import('../model');
const { scopeToString } = await import('../scope');
const { RUNNER_TOKEN_SCOPE } = await import('../runner-client');
const { DEVICE_CODE_GRANT } = await import('../constants');

const ACCOUNT = 6200;
const RUNNER = 'recipe-runner';
const AI_SERVICES = TokenScope.AIServicesRead | TokenScope.AIServicesWrite;
/** What an ordinary app asks for: more than UserRead, so a clamp shows. */
const ASKED = TokenScope.UserRead | TokenScope.ModelsRead;

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
  CREATE TABLE runner_client_bindings (
    runner_client_id TEXT PRIMARY KEY, app_block_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
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

/** A runner client that qualifies; `client` overrides one property, `binding` the binding row. */
async function seedRunner(
  client: Partial<{
    userId: number;
    isConfidential: boolean;
    skipConsent: boolean;
    accessMode: string;
    grants: readonly string[];
  }> = {},
  binding: 'active' | 'suspended' | null = 'active'
) {
  const c = {
    userId: -1,
    isConfidential: true,
    skipConsent: false,
    accessMode: 'open',
    grants: ['authorization_code', 'refresh_token'],
    ...client,
  };
  await pg.query(
    `INSERT INTO "OauthClient" ("id", "userId", "isConfidential", "skipConsent", "accessMode", "grants", "secret")
     VALUES ($1, $2, $3, $4, $5, $6, 'hashed')`,
    [RUNNER, c.userId, c.isConfidential, c.skipConsent, c.accessMode, [...c.grants]]
  );
  if (binding)
    await pg.query(
      `INSERT INTO runner_client_bindings (runner_client_id, app_block_id, status) VALUES ($1, 'ab_1', $2)`,
      [RUNNER, binding]
    );
}

/** Every scope the grant stored, as bigints (the wide column when set). */
const storedScopes = async () =>
  (
    await pg.query<{ s: string }>(
      `SELECT COALESCE("tokenScopeWide", "tokenScope"::text) AS s FROM "ApiKey" ORDER BY "id"`
    )
  ).rows.map((r) => BigInt(r.s));

const client = { id: RUNNER, grants: ['authorization_code', 'refresh_token'] };
const grant = (scope: bigint, user: Record<string, unknown>) =>
  oauthModel.saveToken(
    { scope: scopeToString(scope) } as never,
    client as never,
    { id: ACCOUNT, ...user } as never
  );
const authCode = (scope: bigint) => grant(scope, {});
const refresh = (scope: bigint) => grant(scope, { viaRefresh: true });

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  await pg.query(`INSERT INTO "User" ("id", "username") VALUES ($1, 'runner-user')`, [ACCOUNT]);
  h.db.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  h.db.current = null;
  await pg.close();
});

describe('the authorization-code grant', () => {
  it('issues a runner client exactly RunnerMint | UserRead, whatever was asked, with no AI Services bit', async () => {
    await seedRunner();
    const token = await authCode(TokenScope.UserRead | AI_SERVICES);
    expect(token.scope).toEqual(scopeToString(RUNNER_TOKEN_SCOPE));
    expect(await storedScopes()).toEqual([RUNNER_TOKEN_SCOPE, RUNNER_TOKEN_SCOPE]);
  });

  it.each([
    ['not Civitai-owned', { userId: 1 }, 'active'],
    ['public', { isConfidential: false }, 'active'],
    ['skip-consent', { skipConsent: true }, 'active'],
    ['testers-only', { accessMode: 'testers' }, 'active'],
    ['disabled', { accessMode: 'disabled' }, 'active'],
    [
      'holding the device grant (URN)',
      { grants: ['authorization_code', DEVICE_CODE_GRANT] },
      'active',
    ],
    [
      'holding the device grant (bare name)',
      { grants: ['authorization_code', 'device_code'] },
      'active',
    ],
    ['unbound', {}, null],
  ] as const)(
    'treats a client %s as an ordinary app: what it asked for, no runner bit',
    async (_, override, binding) => {
      await seedRunner(override, binding);
      await authCode(ASKED);
      expect(await storedScopes()).toEqual([ASKED, ASKED]);
    }
  );

  it('issues a runner whose binding is suspended UserRead alone, never what it asked for', async () => {
    await seedRunner({}, 'suspended');
    await authCode(ASKED);
    expect(await storedScopes()).toEqual([TokenScope.UserRead, TokenScope.UserRead]);
  });
});

describe('the refresh grant', () => {
  it('re-issues a runner token while the client still qualifies', async () => {
    await seedRunner();
    await refresh(RUNNER_TOKEN_SCOPE);
    expect(await storedScopes()).toEqual([RUNNER_TOKEN_SCOPE, RUNNER_TOKEN_SCOPE]);
  });

  it('clamps an older, wider token of a client now bound as a runner to UserRead', async () => {
    await seedRunner();
    await refresh(ASKED);
    expect(await storedScopes()).toEqual([TokenScope.UserRead, TokenScope.UserRead]);
  });

  it('drops the runner bit once the binding is suspended', async () => {
    await seedRunner({}, 'suspended');
    await refresh(RUNNER_TOKEN_SCOPE);
    expect(await storedScopes()).toEqual([TokenScope.UserRead, TokenScope.UserRead]);
  });

  it('does not upgrade an ordinary token of a client that has since become a runner', async () => {
    await seedRunner();
    await refresh(TokenScope.UserRead);
    expect(await storedScopes()).toEqual([TokenScope.UserRead, TokenScope.UserRead]);
  });
});

describe('the client-credentials grant', () => {
  it('never issues the runner bit, even to a qualifying runner client', async () => {
    await seedRunner({ grants: ['authorization_code', 'refresh_token', 'client_credentials'] });
    await grant(TokenScope.UserRead, { id: -1, viaClientCredentials: true });
    const [scope] = await storedScopes();
    expect(scope & TokenScope.RunnerMint).toBe(0n);
  });
});

describe('getAccessToken', () => {
  const store = (key: string, scope: bigint) =>
    pg.query(
      `INSERT INTO "ApiKey" ("key", "tokenScope", "tokenScopeWide", "userId", "type", "clientId")
       VALUES ($1, 1, $2, $3, 'Access', $4)`,
      [key, scope.toString(), ACCOUNT, RUNNER]
    );
  // generateSecretHash salts with NEXTAUTH_SECRET, so store the hash the lookup computes.
  const lookup = async (raw: string, scope: bigint) => {
    const { generateSecretHash } = await import('@civitai/auth/secret-hash');
    await store(generateSecretHash(raw), scope);
    return oauthModel.getAccessToken(raw);
  };

  it('refuses a runner token and a client-credentials token', async () => {
    expect(await lookup('civitai_runner', RUNNER_TOKEN_SCOPE)).toBe(false);
    expect(await lookup('civitai_cc', TokenScope.UserRead | TokenScope.AppStoreCatalogWrite)).toBe(
      false
    );
  });

  it('answers for an ordinary token (positive control)', async () => {
    expect(await lookup('civitai_ordinary', TokenScope.UserRead)).toMatchObject({
      scope: scopeToString(TokenScope.UserRead),
    });
  });
});

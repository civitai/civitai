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

/**
 * What the consent screen counts as already granted to an app: the remembered consent, else the
 * user's newest live refresh token for that app. It decides which permissions are labelled "New".
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('$lib/server/db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getGrantedScope } = await import('../granted-scope');

const PRELUDE = `
  CREATE TABLE "OauthConsent" (
    "userId" INTEGER NOT NULL, "clientId" TEXT NOT NULL, "scope" INTEGER NOT NULL,
    PRIMARY KEY ("userId", "clientId")
  );
  CREATE TABLE "ApiKey" (
    "id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "clientId" TEXT, "type" TEXT NOT NULL,
    "tokenScope" INTEGER NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "expiresAt" TIMESTAMP
  );
`;

const USER = 7;
const CLIENT = 'app-one';
const NOW = new Date('2026-11-12T12:00:00Z');
const HOUR = 3_600_000;

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

const consent = (userId: number, clientId: string, scope: number) =>
  pg.query(`INSERT INTO "OauthConsent" ("userId", "clientId", "scope") VALUES ($1, $2, $3)`, [
    userId,
    clientId,
    scope,
  ]);

const apiKey = (row: {
  userId?: number;
  clientId?: string;
  type?: string;
  scope: number;
  createdAt?: Date;
  expiresAt?: Date | null;
}) =>
  pg.query(
    `INSERT INTO "ApiKey" ("userId", "clientId", "type", "tokenScope", "createdAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      row.userId ?? USER,
      row.clientId ?? CLIENT,
      row.type ?? 'Refresh',
      row.scope,
      row.createdAt ?? new Date(NOW.getTime() - HOUR),
      row.expiresAt === undefined ? new Date(NOW.getTime() + HOUR) : row.expiresAt,
    ]
  );

const granted = () => getGrantedScope(USER, CLIENT, NOW);

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('getGrantedScope', () => {
  it('is the remembered consent when there is one, over a refresh token', async () => {
    await consent(USER, CLIENT, 3);
    await apiKey({ scope: 15 });
    await expect(granted()).resolves.toBe(3);
  });

  it('falls back to the newest live refresh token when nothing was remembered', async () => {
    await apiKey({ scope: 1, createdAt: new Date(NOW.getTime() - 3 * HOUR) });
    await apiKey({ scope: 5, createdAt: new Date(NOW.getTime() - HOUR) });
    await apiKey({ scope: 3, createdAt: new Date(NOW.getTime() - 2 * HOUR) });
    await expect(granted()).resolves.toBe(5);
  });

  it('counts a refresh token with no expiry as live', async () => {
    await apiKey({ scope: 9, expiresAt: null });
    await expect(granted()).resolves.toBe(9);
  });

  it('is null when the user has granted this app nothing', async () => {
    await expect(granted()).resolves.toBeNull();
  });

  it("ignores another app's consent and refresh tokens", async () => {
    await consent(USER, 'app-two', 3);
    await apiKey({ clientId: 'app-two', scope: 15 });
    await expect(granted()).resolves.toBeNull();
  });

  it("ignores another user's consent and refresh tokens for the same app", async () => {
    await consent(8, CLIENT, 3);
    await apiKey({ userId: 8, scope: 15 });
    await expect(granted()).resolves.toBeNull();
  });

  it('ignores an expired refresh token', async () => {
    await apiKey({ scope: 15, expiresAt: new Date(NOW.getTime() - 1) });
    await expect(granted()).resolves.toBeNull();
  });

  it('ignores access tokens and other key types', async () => {
    await apiKey({ type: 'Access', scope: 15 });
    await apiKey({ type: 'User', scope: 15 });
    await expect(granted()).resolves.toBeNull();
  });
});

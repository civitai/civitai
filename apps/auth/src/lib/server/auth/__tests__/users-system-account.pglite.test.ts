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
 * A system account carries a real, verified email but is driven by API keys only. Whoever can read
 * that inbox, or holds a provider identity on that address, must not get a session for it.
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('../../db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../session', () => ({
  toSessionUser: (row: { id: number }) => ({ id: row.id }),
}));

const { findOrCreateUser, findOrCreateUserByEmail, SystemAccountSignInError } = await import(
  '../users'
);

const PRELUDE = `
  CREATE TABLE "User" (
    "id" SERIAL PRIMARY KEY, "username" TEXT UNIQUE, "name" TEXT, "email" TEXT UNIQUE,
    "emailVerified" TIMESTAMP, "image" TEXT, "meta" JSONB NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "Account" (
    "userId" INTEGER NOT NULL, "type" TEXT, "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL, "scope" TEXT
  );
`;

const EMAIL = 'disputes@civitai.com';
const ACCOUNT_ID = 9001;

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

const seedAccount = (meta: object) =>
  pg.query(
    `INSERT INTO "User" ("id", "username", "email", "emailVerified", "meta") VALUES ($1, 'CivDisputes', $2, now(), $3)`,
    [ACCOUNT_ID, EMAIL, JSON.stringify(meta)]
  );

const linkedAccounts = async () =>
  (await pg.query(`SELECT * FROM "Account" WHERE "userId" = $1`, [ACCOUNT_ID])).rows;

const verifiedProfile = { providerAccountId: 'g-1', email: EMAIL, emailVerified: true };

beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(PRELUDE);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
});

afterEach(async () => {
  dbHandle.current = null;
  await pg.close();
});

describe('sign-in to a system account', () => {
  describe('an ordinary account on the same address (positive control)', () => {
    beforeEach(() => seedAccount({}));

    it('signs in by magic link', async () => {
      await expect(findOrCreateUserByEmail(EMAIL)).resolves.toEqual({ id: ACCOUNT_ID });
    });

    it('links a verified OAuth identity and signs in', async () => {
      await expect(findOrCreateUser('google', verifiedProfile)).resolves.toEqual({
        id: ACCOUNT_ID,
      });
      expect(await linkedAccounts()).toHaveLength(1);
    });
  });

  describe('a system account', () => {
    beforeEach(() => seedAccount({ systemAccount: true }));

    it('refuses a magic link to its inbox', async () => {
      await expect(findOrCreateUserByEmail(EMAIL)).rejects.toBeInstanceOf(SystemAccountSignInError);
    });

    it('refuses a verified OAuth identity on its address, without linking it', async () => {
      await expect(findOrCreateUser('google', verifiedProfile)).rejects.toBeInstanceOf(
        SystemAccountSignInError
      );
      expect(await linkedAccounts()).toHaveLength(0);
    });

    it('refuses an OAuth identity that is already linked to it', async () => {
      await pg.query(
        `INSERT INTO "Account" ("userId", "type", "provider", "providerAccountId") VALUES ($1, 'oauth', 'github', 'gh-1')`,
        [ACCOUNT_ID]
      );

      await expect(
        findOrCreateUser('github', { providerAccountId: 'gh-1' })
      ).rejects.toBeInstanceOf(SystemAccountSignInError);
    });
  });
});

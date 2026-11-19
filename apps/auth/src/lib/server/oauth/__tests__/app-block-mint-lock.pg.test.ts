import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';
import type { DB } from '@civitai/db-schema/kysely';

/**
 * The app-token mint against a suspension, on a real Postgres with two connections: the row lock is
 * the whole fix, and only a real server takes one. A suspension here is what the main app's writers do
 * in one transaction: flip the block to `suspended`, then delete the client's tokens.
 */

// The apps CI job's throwaway server, which each suite makes its own database on.
const TEST_DATABASE_URL =
  process.env.AUTH_TEST_DATABASE_URL ?? process.env.ASSISTANT_RUNNER_TEST_DATABASE_URL;
const describePg = TEST_DATABASE_URL ? describe : describe.skip;
if (process.env.CI && !TEST_DATABASE_URL) throw new Error('no test database URL in CI');

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));
vi.mock('$lib/server/db/db', () => ({
  get db() {
    if (!dbHandle.current) throw new Error('the test database was not installed');
    return dbHandle.current;
  },
}));

vi.mock('@civitai/auth/secret-hash', () => ({
  generateKey: () => Math.random().toString(36).slice(2),
  generateSecretHash: (s: string) => `hash:${s}`,
}));

const { createAppAccessToken, AppBlockSuspendedError } = await import('../token-helpers');

const CLIENT = 'app-block-client-1';
const DB_NAME = `auth_mint_lock_${process.pid}_${Date.now()}`;
const NO_LOCK_ROLE = `mint_no_lock_${process.pid}`;

const SCHEMA = `
  CREATE TABLE app_blocks (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, status TEXT NOT NULL);
  CREATE TABLE "ApiKey" (
    id SERIAL PRIMARY KEY, key TEXT NOT NULL, name TEXT NOT NULL, "tokenScope" INTEGER NOT NULL,
    "tokenScopeWide" TEXT, "userId" INTEGER NOT NULL, type TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3), "clientId" TEXT
  );
`;

function urlFor(database: string, user?: string) {
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = 'x';
  }
  return url.toString();
}

const mint = () =>
  createAppAccessToken(7, CLIENT, TokenScope.UserRead, 600, { refuseSuspendedAppBlock: true });

describePg('app-token mint vs a suspension, on two real connections', () => {
  let admin: pg.Client;
  let suspender: pg.Client;
  let pool: pg.Pool;

  const liveTokens = async () =>
    Number(
      (await admin.query('SELECT count(*) FROM "ApiKey" WHERE "clientId" = $1', [CLIENT])).rows[0]
        .count
    );

  /** Waits until another backend of this database is waiting on `waitEvent` (a lock, or pg_sleep). */
  async function waitForBackend(waitEventType: string, waitEvent?: string) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { rows } = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()
           AND wait_event_type = $2 AND ($3::text IS NULL OR wait_event = $3)`,
        [DB_NAME, waitEventType, waitEvent ?? null]
      );
      if (rows.length) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  beforeAll(async () => {
    const server = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await server.connect();
    await server.query(`CREATE DATABASE ${DB_NAME}`);
    await server.query(`DROP ROLE IF EXISTS ${NO_LOCK_ROLE}`);
    await server.query(`CREATE ROLE ${NO_LOCK_ROLE} LOGIN PASSWORD 'x'`);
    await server.end();

    admin = new pg.Client({ connectionString: urlFor(DB_NAME) });
    suspender = new pg.Client({ connectionString: urlFor(DB_NAME) });
    await Promise.all([admin.connect(), suspender.connect()]);
    await admin.query(SCHEMA);
    pool = new pg.Pool({ connectionString: urlFor(DB_NAME), max: 4 });
  });

  afterAll(async () => {
    await pool?.end();
    await Promise.all([admin?.end(), suspender?.end()]);
    const server = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await server.connect();
    await server.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await server.query(`DROP ROLE IF EXISTS ${NO_LOCK_ROLE}`);
    await server.end();
  });

  beforeEach(async () => {
    dbHandle.current = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    await admin.query('TRUNCATE app_blocks, "ApiKey"');
    await admin.query('DROP TRIGGER IF EXISTS slow_insert ON "ApiKey"');
  });

  // A failed case can leave the suspension open, which would park every later case on its lock.
  afterEach(() => suspender.query('ROLLBACK'));

  it('refuses a mint that waited on a suspension, which leaves the client no token', async () => {
    await admin.query(`INSERT INTO app_blocks VALUES ('b1', $1, 'approved')`, [CLIENT]);
    await suspender.query('BEGIN');
    await suspender.query(`UPDATE app_blocks SET status = 'suspended' WHERE id = 'b1'`);
    await suspender.query('DELETE FROM "ApiKey" WHERE "clientId" = $1', [CLIENT]);

    const minting = mint();
    minting.catch(() => undefined);
    // The mint is parked on the suspension's row lock, not reading around it.
    expect(await waitForBackend('Lock')).toBe(true);
    await suspender.query('COMMIT');

    await expect(minting).rejects.toBeInstanceOf(AppBlockSuspendedError);
    expect(await liveTokens()).toBe(0);
  });

  it('a mint already in flight holds off the suspension, whose delete then removes its token', async () => {
    await admin.query(`INSERT INTO app_blocks VALUES ('b1', $1, 'approved')`, [CLIENT]);
    // Holds the mint's transaction open between its lock read and its commit.
    await admin.query(`
      CREATE OR REPLACE FUNCTION slow_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_insert BEFORE INSERT ON "ApiKey" FOR EACH ROW EXECUTE FUNCTION slow_insert();
    `);

    const minting = mint();
    expect(await waitForBackend('Timeout', 'PgSleep')).toBe(true);

    await suspender.query('BEGIN');
    const suspending = suspender.query(
      `UPDATE app_blocks SET status = 'suspended' WHERE id = 'b1'`
    );
    expect(await waitForBackend('Lock')).toBe(true);

    await expect(minting).resolves.toMatchObject({ accessToken: expect.any(String) });
    await suspending;
    const deleted = await suspender.query('DELETE FROM "ApiKey" WHERE "clientId" = $1', [CLIENT]);
    await suspender.query('COMMIT');

    expect(deleted.rowCount).toBe(1);
    expect(await liveTokens()).toBe(0);
  });

  it.each([
    ['an approved block', ['approved']],
    ['no block at all (an ordinary OAuth client)', []],
    ['a suspended block beside an approved one', ['suspended', 'approved']],
    ['only a pending block', ['pending']],
  ])('mints for a client with %s', async (_, statuses) => {
    for (const [i, status] of statuses.entries()) {
      await admin.query('INSERT INTO app_blocks VALUES ($1, $2, $3)', [`b${i}`, CLIENT, status]);
    }
    await expect(mint()).resolves.toMatchObject({ accessToken: expect.any(String) });
    expect(await liveTokens()).toBe(1);
  });

  it('refuses a client whose only block is suspended, and ignores another client’s blocks', async () => {
    await admin.query(`INSERT INTO app_blocks VALUES ('b1', $1, 'suspended')`, [CLIENT]);
    await admin.query(`INSERT INTO app_blocks VALUES ('b2', 'another-client', 'approved')`);
    await expect(mint()).rejects.toBeInstanceOf(AppBlockSuspendedError);
    expect(await liveTokens()).toBe(0);
  });

  it('mints nothing when the lock cannot be taken: FOR SHARE needs UPDATE, not just SELECT', async () => {
    await admin.query(`INSERT INTO app_blocks VALUES ('b1', $1, 'approved')`, [CLIENT]);
    await admin.query(`GRANT SELECT, INSERT ON "ApiKey" TO ${NO_LOCK_ROLE}`);
    await admin.query(`GRANT USAGE ON SEQUENCE "ApiKey_id_seq" TO ${NO_LOCK_ROLE}`);
    await admin.query(`GRANT SELECT ON app_blocks TO ${NO_LOCK_ROLE}`);
    const restricted = new pg.Pool({ connectionString: urlFor(DB_NAME, NO_LOCK_ROLE), max: 1 });
    try {
      dbHandle.current = new Kysely<DB>({ dialect: new PostgresDialect({ pool: restricted }) });
      await expect(mint()).rejects.toThrow(/permission denied/);
      expect(await liveTokens()).toBe(0);

      // Control: the same role with UPDATE on app_blocks mints.
      await admin.query(`GRANT UPDATE ON app_blocks TO ${NO_LOCK_ROLE}`);
      await expect(mint()).resolves.toMatchObject({ accessToken: expect.any(String) });
      expect(await liveTokens()).toBe(1);
    } finally {
      await restricted.end();
      await admin.query(`REVOKE ALL ON app_blocks, "ApiKey" FROM ${NO_LOCK_ROLE}`);
      await admin.query(`REVOKE ALL ON SEQUENCE "ApiKey_id_seq" FROM ${NO_LOCK_ROLE}`);
    }
  });
});

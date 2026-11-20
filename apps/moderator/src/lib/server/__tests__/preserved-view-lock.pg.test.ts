import { randomBytes } from 'node:crypto';
import { createKyselyClients } from '@civitai/db/kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * `recordPreservedVerdict` against a real Postgres server, for what PGlite cannot show: a second
 * session. A verdict being written in another transaction must make this one wait and then refuse.
 */

// Same fallback as page-access-lock.pg.test.ts.
const SERVER_ENV = process.env.MODERATOR_TEST_DATABASE_URL
  ? 'MODERATOR_TEST_DATABASE_URL'
  : 'ASSISTANT_RUNNER_TEST_DATABASE_URL';
const SERVER_URL = process.env[SERVER_ENV];
const describePg = SERVER_URL ? describe : describe.skip;
if (process.env.CI && !SERVER_URL)
  throw new Error('MODERATOR_TEST_DATABASE_URL (or its fallback) is not set in CI');

const handles = vi.hoisted(() => ({ main: null as unknown }));
vi.mock('../db', () => ({
  get dbRead() {
    return handles.main;
  },
  get dbWrite() {
    return handles.main;
  },
}));
vi.mock('../access', () => ({ canAccess: () => true }));
vi.mock('../axiom', () => ({ logToAxiom: async () => {} }));

const { recordPreservedVerdict } = await import('../preserved-view');

const FILE = { n: 1, key: 'fixture/1.png', size: 10, sha256: 'c'.repeat(64) };
const ENTITY = `preservedFile:${'c'.repeat(16)}`;
const DDL = `CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "credential" TEXT
)`;

const connect = (connectionString: string) =>
  createKyselyClients<Record<string, never>>({ connectionString, singleClient: true });

describePg('recordPreservedVerdict against a verdict in another session', () => {
  const name = `mod_preserved_view_${randomBytes(4).toString('hex')}`;
  let server: ReturnType<typeof connect>;
  let app: ReturnType<typeof connect>;
  let other: ReturnType<typeof connect>;

  beforeAll(async () => {
    console.info(`[preserved-view-lock.pg] Postgres from ${SERVER_ENV}`);
    server = connect(SERVER_URL!);
    await server.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(SERVER_URL!);
    url.pathname = `/${name}`;
    app = connect(url.toString());
    other = connect(url.toString());
    await other.pool.query(DDL);
    handles.main = app.db;
  });

  afterAll(async () => {
    await app?.pool.end();
    await other?.pool.end();
    await server?.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await server?.pool.end();
  });

  it('waits for the other verdict to commit, then refuses', async () => {
    const session = await other.pool.connect();
    try {
      await session.query('BEGIN');
      await session.query('SELECT pg_advisory_xact_lock(hashtext($1), 0)', [ENTITY]);
      await session.query(
        `INSERT INTO "ModActivity" ("userId", "activity", "entityType", "entityId")
         VALUES (502, 'preservedFile:verdict-apparent', $1, 1)`,
        [ENTITY]
      );
      let settled = false;
      const mine = recordPreservedVerdict(FILE, 501, 'not').finally(() => (settled = true));
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false);
      await session.query('COMMIT');
      expect(await mine).toBe('already');
    } finally {
      session.release();
    }
    const { rows } = await other.pool.query(
      `SELECT count(*)::int AS n FROM "ModActivity" WHERE "entityId" = 1`
    );
    expect(rows[0].n).toBe(1);
  });
});

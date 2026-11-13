import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/** Against real Postgres: what must hold is a property of the SQL (the server stamp and other keys
 * survive, no other row is touched). */
const URL_BASE = process.env.APPDATA_TEST_DATABASE_URL;
const DB_NAME = 'feedback_hq_record_test';

const { recordHqTask } = await import('~/server/services/feedback-hq.service');

describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(URL_BASE, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

const SAVED = {
  route: '/models/[id]',
  consoleErrors: [{ message: 'TypeError: x is undefined', count: 2 }],
  server: { site: 'red', tier: 'gold', build: '5.1.444', flags: { assistant: true } },
};
const TASK = { id: 'task_1', url: 'https://hq.civitai.com/tasks/task_1' };

describe.skipIf(!URL_BASE)('recording the HQ task on Postgres', () => {
  let prisma: PrismaClient;
  let sql: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: URL_BASE });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();

    const url = new URL(URL_BASE!);
    url.pathname = `/${DB_NAME}`;
    sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    await sql.query(
      `CREATE TABLE "Feedback" (id SERIAL PRIMARY KEY, "context" JSONB NOT NULL DEFAULT '{}')`
    );
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await sql?.end();
  });

  beforeEach(async () => {
    await sql.query(`TRUNCATE "Feedback" RESTART IDENTITY`);
    await sql.query(`INSERT INTO "Feedback" ("context") VALUES ($1), ($1)`, [
      JSON.stringify(SAVED),
    ]);
  });

  const contextOf = async (id: number) =>
    (await sql.query(`SELECT "context" FROM "Feedback" WHERE id = $1`, [id])).rows[0].context;

  it('adds `hq` and keeps the server stamp and every other saved key', async () => {
    await recordHqTask(1, TASK, prisma);

    expect(await contextOf(1)).toEqual({ ...SAVED, hq: TASK });
  });

  it('touches no other report', async () => {
    await recordHqTask(1, TASK, prisma);

    expect(await contextOf(2)).toEqual(SAVED);
  });
});

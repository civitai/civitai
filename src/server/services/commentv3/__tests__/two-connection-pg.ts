import { Prisma } from '@prisma/client';
import { Client, Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Real Postgres for tests whose subject is a lock: `dbMock.dbWrite.$transaction` gets its own
 * connection per call, and a test can hold one open at a chosen statement. Runs in a scratch
 * schema on `APPDATA_TEST_DATABASE_URL`, the throwaway server CI provides.
 */
export const TEST_DATABASE_URL = process.env.APPDATA_TEST_DATABASE_URL;

const DDL = `
  CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
  CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'Spam');
  CREATE TABLE "CommentV3" (id int PRIMARY KEY, "userId" int NOT NULL,
    hidden boolean NOT NULL DEFAULT false, "hiddenAt" timestamptz,
    "tosViolation" boolean NOT NULL DEFAULT false, "pinnedAt" timestamptz,
    "deletedAt" timestamptz, "updatedAt" timestamptz NOT NULL DEFAULT now(), "legacyV1Id" int);
  CREATE TABLE "Report" (id int PRIMARY KEY, "userId" int NOT NULL,
    status "ReportStatus" NOT NULL, reason "ReportReason" NOT NULL,
    "statusSetAt" timestamptz, "statusSetBy" int);
  CREATE TABLE "CommentV3Report" ("commentId" int NOT NULL, "reportId" int NOT NULL);`;

type Hook = (sql: string) => Promise<void>;
let beforeQuery: Hook | null = null;

const sqlOf = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

/** The Prisma raw methods the comment services use, over one pg connection or the pool. */
export function runnerOn(c: Pick<PoolClient, 'query'>) {
  const run = async (text: string, params: unknown[]) => {
    await beforeQuery?.(text);
    return c.query(text, params);
  };
  return {
    $queryRaw: async (first: never, ...values: unknown[]) => {
      const sql = sqlOf(first, values);
      return (await run(sql.text, sql.values as unknown[])).rows;
    },
    $executeRaw: async (first: never, ...values: unknown[]) => {
      const sql = sqlOf(first, values);
      return (await run(sql.text, sql.values as unknown[])).rowCount ?? 0;
    },
    $queryRawUnsafe: async (text: string, ...params: unknown[]) => (await run(text, params)).rows,
  };
}

export async function openScratch(name: string) {
  const schema = `${name}_${process.pid}`;
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4, application_name: schema });
  pool.on('connect', (c) => void c.query(`SET search_path TO ${schema}`));
  const q = async <T>(sql: string) => (await pool.query(sql)).rows as T[];
  const one = async <T>(sql: string) => (await q<T>(sql))[0];
  // Every statement is unqualified: refuse to run anywhere but the scratch schema.
  expect(await one<{ s: string }>('SELECT current_schema() AS s')).toEqual({ s: schema });
  await pool.query(DDL);

  const db = dbMock.dbWrite;
  const saved = [db.$queryRaw, db.$executeRaw, db.$queryRawUnsafe, db.$transaction].map((m) =>
    m.getMockImplementation()
  );
  const outside = runnerOn(pool);
  db.$queryRaw.mockImplementation(outside.$queryRaw as never);
  db.$executeRaw.mockImplementation(outside.$executeRaw as never);
  db.$queryRawUnsafe.mockImplementation(outside.$queryRawUnsafe as never);
  db.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(runnerOn(c));
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }) as never);

  return {
    pool,
    q,
    one,
    reset: async () => {
      beforeQuery = null;
      await q(`TRUNCATE "CommentV3", "Report", "CommentV3Report"`);
    },
    /** Whether `done` ends up waiting on a lock on this scratch's connections, or finishes first. */
    lockWaitOrFinish: async (done: Promise<unknown>) => {
      let finished = false;
      void done.then(
        () => (finished = true),
        () => (finished = true)
      );
      for (let i = 0; i < 200; i++) {
        const { n } = (await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE application_name = '${schema}' AND wait_event_type = 'Lock'`
        ))!;
        if (n) return 'waiting';
        if (finished) return 'finished';
        await new Promise((r) => setTimeout(r, 25));
      }
      return 'timeout';
    },
    close: async () => {
      beforeQuery = null;
      const [queryRaw, executeRaw, queryRawUnsafe, transaction] = saved;
      db.$queryRaw.mockImplementation(queryRaw as never);
      db.$executeRaw.mockImplementation(executeRaw as never);
      db.$queryRawUnsafe.mockImplementation(queryRawUnsafe as never);
      db.$transaction.mockImplementation(transaction as never);
      await pool.end();
      const c = new Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
    },
  };
}

/** Holds the first statement matching `at`, on any connection, until `release`. */
export function holdAt(at: RegExp) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const reachedAt = new Promise<void>((r) => (reached = r));
  let armed = true;
  beforeQuery = async (sql) => {
    if (armed && at.test(sql)) {
      armed = false;
      reached();
      await gate;
    }
  };
  return {
    release,
    /** Resolves when the statement is reached; stops holding any later one. */
    reachedAt: reachedAt.then(() => {
      beforeQuery = null;
    }),
  };
}

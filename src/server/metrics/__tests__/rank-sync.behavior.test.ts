import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// The job runs as a role that is a member of the table's owner, so the old drop + recreate could
// run and hand the new table to the job's role; app_read's SELECT is the grant that must survive.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: vi.fn(() => Promise.resolve([])) },
}));
vi.mock('~/server/jobs/job', () => ({
  getJobDate: vi.fn(async () => [new Date(0), vi.fn(() => Promise.resolve())] as const),
}));

const holder = vi.hoisted(() => ({ pg: null as unknown as PGlite }));
const db = dbMock.dbWrite;
const exec = async (sql: string, ...params: unknown[]) =>
  (await holder.pg.query(sql, params)).affectedRows ?? 0;
const query = async (sql: string, ...params: unknown[]) =>
  (await holder.pg.query(sql, params)).rows;
db.$executeRawUnsafe.mockImplementation(exec as never);
db.$queryRawUnsafe.mockImplementation(query as never);
db.$transaction.mockImplementation((async (arg: unknown) => {
  if (Array.isArray(arg)) return Promise.all(arg);
  await holder.pg.exec('BEGIN');
  try {
    const result = await (arg as (tx: unknown) => Promise<unknown>)(db);
    await holder.pg.exec('COMMIT');
    return result;
  } catch (error) {
    await holder.pg.exec('ROLLBACK');
    throw error;
  }
}) as never);

const { createMetricProcessor } = await import('~/server/metrics/base.metrics');

const jobContext = { on: vi.fn(), checkIfCanceled: vi.fn(), cancel: vi.fn() } as never;
const refresh = () =>
  createMetricProcessor({
    name: 'Article',
    update: vi.fn(),
    rank: { table: 'ArticleRank', primaryKey: 'articleId' },
  }).refreshRank(jobContext);

const tableState = async () => {
  const [row] = await query(
    `SELECT c.oid::int AS oid, pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege('app_read', c.oid, 'SELECT') AS "readerCanSelect",
      (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid) AS "indexCount"
    FROM pg_class c WHERE c.relname = 'ArticleRank'`
  );
  return row as { oid: number; owner: string; readerCanSelect: boolean; indexCount: number };
};
const ranks = async () =>
  query(`SELECT "articleId", "reactionCountMonthRank" FROM "ArticleRank" ORDER BY "articleId"`);

beforeAll(async () => {
  holder.pg = new PGlite();
  await holder.pg.exec(`
    CREATE ROLE app_read; CREATE ROLE rank_owner; CREATE ROLE jobs_writer;
    GRANT rank_owner TO jobs_writer;
    GRANT CREATE ON SCHEMA public TO jobs_writer;
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.pg.exec(`
    RESET ROLE;
    DROP VIEW IF EXISTS "ArticleRank_Live";
    DROP TABLE IF EXISTS "ArticleRank", "ArticleRank_New", "ArticleMetric";

    CREATE TABLE "ArticleMetric" ("articleId" int PRIMARY KEY, "reactionCount" int NOT NULL);
    CREATE VIEW "ArticleRank_Live" AS
      SELECT "articleId", ROW_NUMBER() OVER (ORDER BY "reactionCount" DESC, "articleId")::int
        AS "reactionCountMonthRank"
      FROM "ArticleMetric";
    INSERT INTO "ArticleMetric" VALUES (1, 10), (2, 20), (3, 30);

    CREATE TABLE "ArticleRank" AS SELECT * FROM "ArticleRank_Live";
    ALTER TABLE "ArticleRank" ADD CONSTRAINT "pk_ArticleRank" PRIMARY KEY ("articleId");
    CREATE INDEX "ArticleRank_reactionCountMonthRank_idx" ON "ArticleRank" ("reactionCountMonthRank");
    ALTER TABLE "ArticleRank" OWNER TO rank_owner;
    GRANT SELECT ON "ArticleRank" TO app_read;
    GRANT SELECT ON "ArticleRank_Live", "ArticleMetric" TO jobs_writer;
  `);
  await holder.pg.exec(`
    UPDATE "ArticleMetric" SET "reactionCount" = 40 WHERE "articleId" = 1;
    DELETE FROM "ArticleMetric" WHERE "articleId" = 2;
    INSERT INTO "ArticleMetric" VALUES (4, 5);
    SET ROLE jobs_writer;
  `);
});

describe('rank table refresh', () => {
  it('keeps the same table, owner, grants and indexes across two refreshes', async () => {
    const before = await tableState();

    await refresh();
    await refresh();

    expect(await tableState()).toEqual(before);
    expect(before.readerCanSelect).toBe(true);
    expect(before.indexCount).toBe(2);
  });

  it('leaves the table matching the live view: moved ranks updated, gone rows deleted, new rows added', async () => {
    await refresh();

    expect(await ranks()).toEqual([
      { articleId: 1, reactionCountMonthRank: 1 },
      { articleId: 3, reactionCountMonthRank: 2 },
      { articleId: 4, reactionCountMonthRank: 3 },
    ]);
  });

  it('keeps the previous rows and logs the table when the sync fails partway', async () => {
    // Fails on the upsert, after the delete of article 2 has already run.
    await holder.pg.exec(`
      RESET ROLE;
      ALTER TABLE "ArticleRank"
        ADD CONSTRAINT rank_below_3 CHECK ("reactionCountMonthRank" < 3) NOT VALID;
      SET ROLE jobs_writer;
    `);
    const before = await ranks();

    await expect(refresh()).rejects.toThrow(/rank_below_3/);

    expect(await ranks()).toEqual(before);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'metric-rank-sync-failed',
        details: expect.objectContaining({ table: 'ArticleRank' }),
      })
    );
  });
});

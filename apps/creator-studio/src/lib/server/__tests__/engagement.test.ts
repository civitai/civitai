import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown }));

// Kysely compiled for Postgres and executed on PGlite, so the query's joins and filters run against real rows.
class PgliteDriver implements Driver {
  constructor(private pg: PGlite) {}
  async init() {}
  async acquireConnection(): Promise<DatabaseConnection> {
    const pg = this.pg;
    return {
      async executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
        const res = await pg.query(q.sql, [...q.parameters]);
        return { rows: res.rows as R[] };
      },
      // eslint-disable-next-line require-yield
      async *streamQuery() {
        throw new Error('not supported');
      },
    };
  }
  async beginTransaction() {}
  async commitTransaction() {}
  async rollbackTransaction() {}
  async releaseConnection() {}
  async destroy() {}
}

vi.mock('$lib/server/db', () => ({
  get dbRead() {
    return holder.db;
  },
}));
vi.mock('$lib/server/cache', () => ({
  createCache: ({ fetch }: { fetch: unknown }) => ({ get: fetch }),
}));

const { getModelEngagement } = await import('../engagement');

const ME = 1;
const OTHER = 2;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, name text, status text, nsfw boolean, "nsfwLevel" int);
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "commentCount" int DEFAULT 0, "thumbsUpCount" int DEFAULT 0, "thumbsDownCount" int DEFAULT 0
    );
    -- Inserted in the opposite of the expected display order, so a missing sort shows up.
    INSERT INTO "Model" VALUES
      (10, ${ME}, 'quiet', 'Published', false, 1),
      (11, ${ME}, 'commented', 'Published', false, 1),
      (12, ${ME}, 'downvoted, few comments', 'Published', false, 1),
      (13, ${ME}, 'downvoted, many comments', 'Published', false, 1),
      (14, ${ME}, 'no metric row', 'Published', true, 28),
      (15, ${ME}, 'draft', 'Draft', false, 1),
      (16, ${OTHER}, 'someone else', 'Published', false, 1);
    INSERT INTO "ModelMetric" VALUES
      (10, 0, 9, 0), (11, 3, 2, 0), (12, 1, 5, 4), (13, 5, 5, 4), (15, 9, 9, 9), (16, 9, 9, 9);
  `);
  holder.db = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new PgliteDriver(pg),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
});

describe('getModelEngagement', () => {
  it('lists every published model of the creator, including ones with no comments, votes or metric row', async () => {
    const rows = await getModelEngagement({ userId: ME });
    expect(rows.map((r) => r.modelId).sort()).toEqual([10, 11, 12, 13, 14]);
    expect(rows.find((r) => r.modelId === 14)).toMatchObject({
      comments: 0,
      upvotes: 0,
      downvotes: 0,
      nsfw: true,
      nsfwLevel: 28,
    });
  });

  it('sorts by downvotes, then comments, so models needing attention stay on top', async () => {
    const rows = await getModelEngagement({ userId: ME });
    expect(rows.slice(0, 3).map((r) => r.modelId)).toEqual([13, 12, 11]);
    expect(
      rows
        .slice(3)
        .map((r) => r.modelId)
        .sort()
    ).toEqual([10, 14]);
  });
});

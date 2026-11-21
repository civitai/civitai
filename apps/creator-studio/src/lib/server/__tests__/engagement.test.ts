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
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown,
  // ClickHouse fake. The runs read honours its ORDER BY direction and LIMIT 1, so reading the
  // oldest day (or a day from anywhere else) is caught; the rank read returns `ranks`.
  ch: {
    days: [] as string[],
    ranks: [] as { modelId: number; rank: number }[],
    fail: false,
    queries: [] as string[],
  },
}));

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
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    async $query(sql: string) {
      holder.ch.queries.push(sql);
      if (holder.ch.fail) throw new Error('clickhouse down');
      if (sql.includes('model_hot_rank_runs')) {
        const days = [...holder.ch.days].sort();
        if (/ORDER BY day DESC/.test(sql)) days.reverse();
        return (/LIMIT 1\b/.test(sql) ? days.slice(0, 1) : days).map((day) => ({ day }));
      }
      return holder.ch.ranks;
    },
  }),
}));
vi.mock('$lib/server/cache', () => ({
  createCache: ({ fetch }: { fetch: unknown }) => ({ get: fetch }),
}));

const { getModelEngagement, getHotRanks, hotRankAsOf } = await import('../engagement');

beforeEach(() => {
  holder.ch.days = [];
  holder.ch.ranks = [];
  holder.ch.fail = false;
  holder.ch.queries = [];
});

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

describe('getHotRanks', () => {
  it("reads the latest complete day's rank for the creator's published models only", async () => {
    holder.ch.days = ['2026-11-19', '2026-11-20', '2026-11-18'];
    holder.ch.ranks = [
      { modelId: 12, rank: 594 },
      { modelId: 10, rank: 31_000 },
    ];

    const { day, ranks } = await getHotRanks({ userId: ME });

    expect(day).toBe('2026-11-20');
    expect(ranks).toEqual({ 10: 31_000, 12: 594 });
    const rankRead = holder.ch.queries.find((q) => q.includes('model_hot_rank_daily'));
    expect(rankRead).toContain("toDate('2026-11-20')");
    // 15 is a draft and 16 is another creator's: neither may be asked for.
    expect(
      rankRead
        ?.match(/IN \(([^)]*)\)/)?.[1]
        .split(',')
        .map(Number)
        .sort()
    ).toEqual([10, 11, 12, 13, 14]);
  });

  it('reads no ranks when no snapshot day is complete yet', async () => {
    expect(await getHotRanks({ userId: ME })).toEqual({ day: null, ranks: {} });
    expect(holder.ch.queries.some((q) => q.includes('model_hot_rank_daily'))).toBe(false);
  });

  // The cache stores whatever fetch returns: a failure must throw, or "no rank" is cached for an hour.
  it('throws when ClickHouse fails, rather than returning no ranks', async () => {
    holder.ch.fail = true;

    await expect(getHotRanks({ userId: ME })).rejects.toThrow('clickhouse down');
  });
});

describe('hotRankAsOf', () => {
  const at = (iso: string) => new Date(iso);

  it("says last night for today's run, and for yesterday's until today's has had until 06:00 UTC", () => {
    expect(hotRankAsOf('2026-11-21', at('2026-11-21T23:00Z'))).toBe('as of last night');
    expect(hotRankAsOf('2026-11-20', at('2026-11-21T05:30Z'))).toBe('as of last night');
  });

  it('shows the date once a night was missed', () => {
    expect(hotRankAsOf('2026-11-20', at('2026-11-21T07:00Z'))).toBe('as of 2026-11-20');
    expect(hotRankAsOf(null, at('2026-11-21T07:00Z'))).toBeNull();
  });
});

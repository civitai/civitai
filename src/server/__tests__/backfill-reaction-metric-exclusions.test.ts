import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The only test that reads the SQL this backfill actually sends, and the only thing
 * standing between a `dryRun` and a production write.
 *
 * It lives here rather than beside the endpoint because Next treats every file under
 * `src/pages` as a route and fails `next build` on a test file there.
 */

const h = vi.hoisted(() => ({
  excludedIds: vi.fn(),
  captured: [] as string[],
  rowsFor: vi.fn(),
  articleBust: vi.fn(),
  postBust: vi.fn(),
  maxId: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: h.excludedIds,
}));

vi.mock('~/server/db/client', () => ({
  dbWrite: { $queryRawUnsafe: h.maxId },
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbWrite: {
    cancellableQuery: vi.fn(async (sql: string) => {
      h.captured.push(sql);
      const rows = h.rowsFor(sql);
      return { result: async () => rows, cancel: async () => undefined };
    }),
  },
}));

vi.mock('~/server/redis/caches', () => ({
  articleStatCache: { bust: h.articleBust },
  postStatCache: { bust: h.postBust },
}));

const handler = (await import('~/pages/api/admin/temp/backfill-reaction-metric-exclusions'))
  .default as unknown as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;

type RunResult = {
  statusCode: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
};

async function run(query: Record<string, string>): Promise<RunResult> {
  const result: RunResult = { statusCode: 0, body: undefined };
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json(payload: any) {
      result.body = payload;
      return this;
    },
    on: () => undefined,
  };
  // Serialised so the captured statements are in batch order.
  await handler(
    { query: { concurrency: '1', ...query } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  return result;
}

const writes = () => h.captured.filter((sql) => /\bUPDATE "/.test(sql));
const reads = () => h.captured.filter((sql) => !/\bUPDATE "/.test(sql));

/** Ids covered by a batch's range predicate, inclusive of both ends. */
function spanOf(sql: string, column: string) {
  const m = new RegExp(`"${column}" >= (\\d+) AND \\w+\\."${column}" <= (\\d+)`).exec(sql);
  if (!m) throw new Error(`no ${column} range in the statement`);
  return Number(m[2]) - Number(m[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.captured.length = 0;
  h.excludedIds.mockResolvedValue([11, 22]);
  h.rowsFor.mockReturnValue([]);
  h.maxId.mockResolvedValue([{ max: 5 }]);
});

describe('reaction-metric exclusion backfill', () => {
  describe('dryRun', () => {
    it('issues the scan as a SELECT and never an UPDATE', async () => {
      const res = await run({ entity: 'article', dryRun: 'true' });

      expect(res.body.dryRun).toBe(true);
      expect(reads().length, 'the scan was never issued at all').toBeGreaterThan(0);
      expect(writes(), 'a dry run wrote to the metric table').toEqual([]);
    });

    it('does not bust a cache either, even when the scan finds changed rows', async () => {
      // A dry run that busted would still be a production mutation, and the row count it
      // reports is the measurement the prod go/no-go is made on.
      h.rowsFor.mockReturnValue([{ id: 7 }]);

      const res = await run({ entity: 'article', dryRun: 'true' });

      expect(res.body.results.article.rowsChanged, 'the scan reported nothing').toBe(1);
      expect(h.articleBust).not.toHaveBeenCalled();
    });

    it('a real run DOES write — the control for both assertions above', async () => {
      const res = await run({ entity: 'article', dryRun: 'false' });

      expect(res.body.dryRun).toBe(false);
      expect(writes().length).toBeGreaterThan(0);
    });
  });

  describe('the write predicate', () => {
    it('updates only rows that disagree, on every reaction column', async () => {
      await run({ entity: 'article', dryRun: 'false' });
      const sql = writes()[0];

      for (const column of ['heart', 'like', 'dislike', 'laugh', 'cry']) {
        expect(sql, `${column}Count is not compared`).toContain(
          `m."${column}Count" IS DISTINCT FROM s."${column}Count"`
        );
      }
    });

    it('scopes article and post to AllTime and bountyEntry to the matching timeframe', async () => {
      // The two jobs that maintain only AllTime must not have their other timeframes
      // rewritten, and bountyEntry's per-timeframe values must not all take the AllTime
      // total — which is what a single `'AllTime'` literal here would do.
      await run({ entity: 'article', dryRun: 'false' });
      expect(writes()[0]).toContain(`m.timeframe = 'AllTime'`);

      h.captured.length = 0;
      await run({ entity: 'bountyEntry', dryRun: 'false' });
      const sql = writes()[0];
      expect(sql).toContain('m.timeframe = s.timeframe');
      expect(sql, 'bountyEntry was pinned to AllTime').not.toContain(`m.timeframe = 'AllTime'`);
    });

    it('bounds each batch inclusively at BOTH ends', async () => {
      // `> start` is the shape in the repo's own backfill template, and it skips the
      // first id of every batch — silently, since the run still reports rows.
      await run({ entity: 'article', dryRun: 'true' });

      expect(reads()[0]).toMatch(/r\."articleId" >= \d+ AND r\."articleId" <= \d+/);
    });

    it('walks the id space with no gap between consecutive batches', async () => {
      h.maxId.mockResolvedValue([{ max: 25 }]);

      await run({ entity: 'article', dryRun: 'true', batchSize: '10' });

      const ranges = reads().map((sql) => {
        const m = /r\."articleId" >= (\d+) AND r\."articleId" <= (\d+)/.exec(sql)!;
        return [Number(m[1]), Number(m[2])] as const;
      });

      expect(
        ranges.length,
        'the space was covered in one batch, so there is no gap to find'
      ).toBeGreaterThan(1);
      expect(ranges[0][0]).toBe(0);
      expect(ranges[ranges.length - 1][1]).toBe(25);
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i][0], `gap or overlap before batch ${i}`).toBe(ranges[i - 1][1] + 1);
      }
    });
  });

  describe('batch size', () => {
    /**
     * Named for the decision, because the obvious cleanup is to collapse this back to one
     * number in the schema. Do not: the post scan flips plan between 1,000 and 10,000 ids
     * and a 10,000-id post batch does not finish inside the pooler's ceiling. Measured on
     * the prod replica 2026-09-21 — ~1.1s at 1,000, still running at ~60s at 10,000.
     */
    it('defaults post to a smaller batch than article, because post has a plan cliff', async () => {
      h.maxId.mockResolvedValue([{ max: 100000 }]);

      await run({ entity: 'post', dryRun: 'true' });
      const postSpan = spanOf(reads()[0], 'postId');

      h.captured.length = 0;
      await run({ entity: 'article', dryRun: 'true' });
      const articleSpan = spanOf(reads()[0], 'articleId');

      expect(postSpan).toBe(1000);
      expect(articleSpan).toBe(10000);
    });

    it('lets an explicit batchSize override the per-entity default', async () => {
      h.maxId.mockResolvedValue([{ max: 100000 }]);

      await run({ entity: 'post', dryRun: 'true', batchSize: '250' });

      expect(spanOf(reads()[0], 'postId')).toBe(250);
    });
  });

  describe('the exclusion list', () => {
    it('filters the REACTOR, by the alias the reaction table is bound to', async () => {
      // `Image` also has a `userId`, so naming the wrong alias in the post query is valid
      // SQL that filters by the post owner instead — invisible to a check that only looks
      // for the predicate text.
      await run({ entity: 'post', dryRun: 'true' });
      const sql = reads()[0];

      const alias = /FROM "ImageReaction"\s+(\w+)/.exec(sql)?.[1];
      expect(alias, 'the reaction table is not in the statement').toBeDefined();
      expect(sql).toContain(`AND ${alias}."userId" IN (11,22)`);
      expect(sql).toContain(`AND ${alias}."userId" NOT IN (11,22)`);
    });

    it('issues nothing at all when the list is empty', async () => {
      h.excludedIds.mockResolvedValue([]);

      const res = await run({ entity: 'all', dryRun: 'true' });

      expect(res.body.excludedUsers).toBe(0);
      expect(h.captured).toEqual([]);
    });

    it('refuses to build SQL from a non-integer id', async () => {
      h.excludedIds.mockResolvedValue([11, 22.5]);

      await expect(run({ entity: 'article', dryRun: 'true' })).rejects.toThrow(
        'non-integer excluded user id'
      );
      expect(h.captured, 'a statement was built before the guard ran').toEqual([]);
    });

    it('reports a digest that is stable under reordering and changes with the list', async () => {
      // The list grew 557 -> 571 between this work being written and being run. Without
      // the digest, a residual that does not match an earlier run cannot be told from a
      // list that moved underneath it.
      const a = (await run({ entity: 'article', dryRun: 'true' })).body.excludedUsersDigest;

      h.excludedIds.mockResolvedValue([22, 11]);
      const reordered = (await run({ entity: 'article', dryRun: 'true' })).body.excludedUsersDigest;

      h.excludedIds.mockResolvedValue([11, 23]);
      const different = (await run({ entity: 'article', dryRun: 'true' })).body.excludedUsersDigest;

      expect(reordered).toBe(a);
      expect(different).not.toBe(a);
    });
  });

  describe('cache busting', () => {
    it('busts exactly the ids the statement changed, deduplicated', async () => {
      h.rowsFor.mockReturnValue([{ id: 3 }, { id: 3 }, { id: 9 }]);

      await run({ entity: 'article', dryRun: 'false' });

      expect(h.articleBust).toHaveBeenCalledTimes(1);
      expect(h.articleBust).toHaveBeenCalledWith([3, 9]);
    });

    it('does not bust when nothing changed', async () => {
      h.rowsFor.mockReturnValue([]);

      await run({ entity: 'article', dryRun: 'false' });

      expect(h.articleBust).not.toHaveBeenCalled();
    });
  });

  describe('failed batches', () => {
    it('counts a throwing batch instead of letting it read as a low row count', async () => {
      // `dataProcessor` catches a throwing processor and only logs it, so without the
      // endpoint's own catch a failed batch is indistinguishable from an empty one.
      h.maxId.mockResolvedValue([{ max: 25 }]);
      let call = 0;
      h.rowsFor.mockImplementation(() => {
        call++;
        if (call === 2) throw new Error('canceling statement due to statement timeout');
        return [{ id: call }];
      });

      const res = await run({ entity: 'article', dryRun: 'false', batchSize: '10' });

      expect(res.body.results.article.batchErrors).toBe(1);
      expect(res.body.results.article.rowsChanged, 'the failed batch was counted as rows').toBe(2);
    });

    it('reports zero errors on a clean run — the control for the assertion above', async () => {
      h.maxId.mockResolvedValue([{ max: 25 }]);
      h.rowsFor.mockReturnValue([{ id: 1 }]);

      const res = await run({ entity: 'article', dryRun: 'false', batchSize: '10' });

      expect(res.body.results.article.batchErrors).toBe(0);
      expect(res.body.results.article.rowsChanged).toBe(3);
    });
  });
});

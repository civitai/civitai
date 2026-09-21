import { readFileSync } from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { ReviewReactions } from '~/shared/utils/prisma/enums';

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
  queueUpdate: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: unknown) => handler,
}));

vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: h.excludedIds,
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

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: h.queueUpdate },
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

const setMaxId = (max: number) =>
  dbMock.dbWrite.$queryRawUnsafe.mockResolvedValue([{ max }] as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.captured.length = 0;
  h.excludedIds.mockResolvedValue([11, 22]);
  h.rowsFor.mockReturnValue([]);
  // Re-declared rather than left to clearAllMocks, which clears recorded calls but keeps
  // implementations — a rejection queued by one test would otherwise make the next test's
  // propagation fail for a reason that has nothing to do with it.
  h.queueUpdate.mockResolvedValue(undefined);
  h.articleBust.mockResolvedValue(undefined);
  h.postBust.mockResolvedValue(undefined);
  setMaxId(5);
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

  describe('the shortest possible call is not a production write', () => {
    /**
     * Named for the decision. `dryRun` defaulting TRUE looks like an inconsistency next to
     * some siblings in this directory and is easy to "tidy" back to false. Do not: with no
     * params at all this endpoint would otherwise rewrite reaction totals across all three
     * metric tables, unsliced, in a single request the file's own header says not to issue
     * — and the visible effect is that reaction counts drop.
     */
    it('defaults to a dry run when no params are given', async () => {
      const res = await run({});

      expect(res.body.dryRun).toBe(true);
      expect(writes(), 'a bare call wrote to production').toEqual([]);
    });

    it('still writes when asked to — the control for the assertion above', async () => {
      const res = await run({ dryRun: 'false' });

      expect(res.body.dryRun).toBe(false);
      expect(writes().length).toBeGreaterThan(0);
    });

    it('runs the cheap entities before the expensive one', async () => {
      // post is ~31k batches and cannot finish inside one request; running it first eats
      // the whole budget and article/bountyEntry never run, with no response body to say so.
      const res = await run({ entity: 'all', dryRun: 'true' });

      expect(Object.keys(res.body.results)).toEqual(['article', 'bountyEntry', 'post']);
    });

    it('is still wrapped by WebhookEndpoint', async () => {
      // The wrapper is mocked to identity here so the SQL can be read, which means no
      // assertion in this file exercises the token check. Read the source instead: an
      // unwrapped handler is an unauthenticated GET that rewrites three metric tables.
      const source = readFileSync(
        path.join(process.cwd(), 'src/pages/api/admin/temp/backfill-reaction-metric-exclusions.ts'),
        'utf8'
      );

      expect(source).toMatch(/export default WebhookEndpoint\(/);
    });
  });

  describe('what gets WRITTEN, not which row gets selected', () => {
    // Every assertion elsewhere in this file reads the row SELECTION — the predicate, the
    // range, the timeframe match. These read the VALUES. A review found the second half
    // completely unasserted, so a SET list assigning every column from s."heartCount"
    // stayed green while three production metric tables took wrong numbers.

    it('assigns each column from its OWN computed sum', async () => {
      await run({ entity: 'article', dryRun: 'false' });
      const sql = writes()[0];

      for (const column of ['heart', 'like', 'dislike', 'laugh', 'cry']) {
        expect(sql, `${column}Count is not assigned from its own sum`).toContain(
          `"${column}Count" = s."${column}Count"`
        );
      }
    });

    it('sums each reaction from its OWN name', async () => {
      await run({ entity: 'article', dryRun: 'true' });
      const sql = reads()[0];

      for (const [reaction, column] of [
        ['Heart', 'heart'],
        ['Like', 'like'],
        ['Dislike', 'dislike'],
        ['Laugh', 'laugh'],
        ['Cry', 'cry'],
      ]) {
        expect(sql, `${column}Count is not summed from '${reaction}'`).toContain(
          `SUM(CASE WHEN r.reaction = '${reaction}' THEN 1 ELSE 0 END)::int AS "${column}Count"`
        );
      }
    });

    it('covers every reaction the enum defines, not a hand-written five', async () => {
      // The SET list and the differs predicate are built from a local array while
      // bountyEntry's sums come from the enum via snippets. A sixth reaction value would
      // diverge them silently, and the new column would never be corrected.
      await run({ entity: 'article', dryRun: 'false' });
      const sql = writes()[0];

      for (const reaction of Object.keys(ReviewReactions)) {
        const column = reaction.toLowerCase();
        expect(sql, `${reaction} is missing from the SET list`).toContain(`"${column}Count" = s.`);
        expect(sql, `${reaction} is missing from the differs predicate`).toContain(
          `m."${column}Count" IS DISTINCT FROM`
        );
      }
    });

    it('aims each entity at its own metric table and its own reaction table', async () => {
      // Nothing else in this file asserts a table name, so pointing article's spec at
      // PostMetric — or its maxIdSql at "Post", which caps the walk at the wrong id — was
      // invisible.
      const cases = [
        { entity: 'article', metric: 'ArticleMetric', reaction: '"ArticleReaction"' },
        { entity: 'bountyEntry', metric: 'BountyEntryMetric', reaction: '"BountyEntryReaction"' },
        { entity: 'post', metric: 'PostMetric', reaction: '"ImageReaction"' },
      ];

      for (const c of cases) {
        h.captured.length = 0;
        await run({ entity: c.entity, dryRun: 'false' });
        const sql = writes()[0];
        expect(sql, `${c.entity} does not update ${c.metric}`).toContain(`UPDATE "${c.metric}" m`);
        expect(sql, `${c.entity} does not read ${c.reaction}`).toContain(c.reaction);
      }
    });

    it('generates all five timeframes for bountyEntry, not just AllTime', async () => {
      // The timeframe MATCH being right says nothing about the timeframe VALUES. Replacing
      // the enum_range generator with a single 'AllTime' row passes every match assertion
      // while leaving Day/Week/Month/Year on their pre-exclusion totals forever.
      await run({ entity: 'bountyEntry', dryRun: 'false' });
      const sql = writes()[0];

      expect(sql).toContain(`unnest(enum_range(NULL::"MetricTimeframe"))`);
      for (const timeframe of ['Year', 'Month', 'Week', 'Day']) {
        expect(sql, `the ${timeframe} window is not computed`).toContain(
          `tf.timeframe = '${timeframe}'`
        );
      }
    });

    it('stamps updatedAt on every row it writes', async () => {
      await run({ entity: 'article', dryRun: 'false' });

      expect(writes()[0]).toContain('"updatedAt" = NOW()');
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
      setMaxId(25);

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
      setMaxId(100000);

      await run({ entity: 'post', dryRun: 'true' });
      const postSpan = spanOf(reads()[0], 'postId');

      h.captured.length = 0;
      await run({ entity: 'article', dryRun: 'true' });
      const articleSpan = spanOf(reads()[0], 'articleId');

      expect(postSpan).toBe(1000);
      expect(articleSpan).toBe(10000);
    });

    it('lets an explicit batchSize override the per-entity default', async () => {
      setMaxId(100000);

      await run({ entity: 'post', dryRun: 'true', batchSize: '250' });

      expect(spanOf(reads()[0], 'postId')).toBe(250);
    });

    it('keeps the batch count bounded, so a broken cursor fails fast instead of hanging', async () => {
      // `dataProcessor` terminates on `cursor > maxCursor`; a NaN cursor never does, and
      // that is a pure microtask loop vitest's timeout cannot fire on. A ceiling turns
      // that class of defect into a one-second red with a number in the message.
      setMaxId(25);

      await run({ entity: 'article', dryRun: 'true', batchSize: '10' });

      expect(reads().length, 'the walk did not terminate in a sane number of batches').toBeLessThan(
        10
      );
    });
  });

  describe('the range it actually walked', () => {
    it('echoes the resolved start and end, and the batch count', async () => {
      // The documented way to run post is a series of start/end slices kept as the record
      // that the space was covered. Without the range in the response that record cannot
      // be checked against anything.
      setMaxId(25);

      const res = await run({ entity: 'article', dryRun: 'true', batchSize: '10' });

      expect(res.body.results.article.start).toBe(0);
      expect(res.body.results.article.end).toBe(25);
      expect(res.body.results.article.batches).toBe(3);
    });

    it('reports a transposed slice as zero batches, not as a clean sweep', async () => {
      // start above end issues no batches at all and would otherwise answer
      // `rowsChanged: 0, finished: true` — indistinguishable from a slice already correct.
      const res = await run({
        entity: 'article',
        dryRun: 'true',
        start: '20000000',
        end: '2000000',
      });

      expect(res.body.results.article.rowsChanged).toBe(0);
      expect(res.body.results.article.batches, 'a skipped slice looked like a clean one').toBe(0);
      expect(res.body.results.article.start).toBe(20000000);
      expect(res.body.results.article.end).toBe(2000000);
    });

    it('honours an explicit end instead of MAX(id)', async () => {
      setMaxId(100000);

      const res = await run({ entity: 'article', dryRun: 'true', start: '10', end: '40' });

      expect(res.body.results.article.end).toBe(40);
      expect(reads()[0]).toContain('r."articleId" >= 10');
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

    it('filters the excluded reactors out of the sum for EVERY entity', async () => {
      // Deleting the `NOT IN` from the sums join makes the computed sum equal the stored
      // one, so nothing differs, nothing is written, and the run answers `rowsChanged: 0,
      // finished: true` — the backfill defeated, reported as a clean sweep. Per entity,
      // because the alias test below only ever ran `post`.
      const cases = [
        { entity: 'article', table: '"ArticleReaction"' },
        { entity: 'bountyEntry', table: '"BountyEntryReaction"' },
        { entity: 'post', table: '"ImageReaction"' },
      ];

      for (const c of cases) {
        h.captured.length = 0;
        await run({ entity: c.entity, dryRun: 'true' });
        const sql = reads()[0];

        // Two references to the reaction table: one to FIND affected entities (IN), one
        // to RE-SUM them (NOT IN). Both must carry a filter, or the count is unfiltered.
        const references = sql.match(new RegExp(c.table, 'g')) ?? [];
        const filters = sql.match(/"userId" (?:NOT )?IN \(11,22\)/g) ?? [];
        expect(
          filters.length,
          `${c.entity}: ${references.length} table refs, ${filters.length} filters`
        ).toBe(references.length);
        expect(sql, `${c.entity} does not exclude the reactors from its sum`).toContain(
          'NOT IN (11,22)'
        );
      }
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

  describe('propagating a corrected row downstream', () => {
    it('busts exactly the ids the statement changed, deduplicated', async () => {
      h.rowsFor.mockReturnValue([{ id: 3 }, { id: 3 }, { id: 9 }]);

      await run({ entity: 'article', dryRun: 'false' });

      expect(h.articleBust).toHaveBeenCalledTimes(1);
      expect(h.articleBust).toHaveBeenCalledWith([3, 9]);
    });

    it('queues a search-index update for a corrected article, not just a cache bust', async () => {
      // The articles index stores the AllTime reaction counts verbatim, and a search card
      // reads the document rather than the stat cache. These rows are by definition ones
      // the metric job will never revisit, so an unqueued document is wrong permanently,
      // not merely stale. `article.metrics.ts` queues AND busts; so must this.
      h.rowsFor.mockReturnValue([{ id: 3 }, { id: 9 }]);

      await run({ entity: 'article', dryRun: 'false' });

      expect(h.queueUpdate).toHaveBeenCalledTimes(1);
      expect(h.queueUpdate).toHaveBeenCalledWith([
        { id: 3, action: SearchIndexUpdateQueueAction.Update },
        { id: 9, action: SearchIndexUpdateQueueAction.Update },
      ]);
    });

    it('does not queue or bust when nothing changed', async () => {
      h.rowsFor.mockReturnValue([]);

      await run({ entity: 'article', dryRun: 'false' });

      expect(h.articleBust).not.toHaveBeenCalled();
      expect(h.queueUpdate).not.toHaveBeenCalled();
    });

    it('does not queue a search-index update on a dry run', async () => {
      h.rowsFor.mockReturnValue([{ id: 3 }]);

      await run({ entity: 'article', dryRun: 'true' });

      expect(h.queueUpdate).not.toHaveBeenCalled();
    });

    it('counts a failed propagation SEPARATELY, because a re-run cannot repair it', async () => {
      // The rows are already committed when propagation runs, so `IS DISTINCT FROM` will
      // never select them again. Folding this into batchErrors would tell the operator to
      // re-run, which is precisely the thing that does not work.
      h.rowsFor.mockReturnValue([{ id: 3 }]);
      h.queueUpdate.mockRejectedValue(new Error('meilisearch unreachable'));

      const res = await run({ entity: 'article', dryRun: 'false' });

      expect(res.body.results.article.propagationErrors).toBe(1);
      expect(
        res.body.results.article.batchErrors,
        'a propagation failure was counted as a scan failure'
      ).toBe(0);
      expect(res.body.results.article.rowsChanged, 'the rows WERE written').toBe(1);
    });

    it('reports zero propagation errors on a clean run — the control for the above', async () => {
      h.rowsFor.mockReturnValue([{ id: 3 }]);

      const res = await run({ entity: 'article', dryRun: 'false' });

      expect(res.body.results.article.propagationErrors).toBe(0);
    });
  });

  describe('failed batches', () => {
    it('counts a throwing batch instead of letting it read as a low row count', async () => {
      // `dataProcessor` catches a throwing processor and only logs it, so without the
      // endpoint's own catch a failed batch is indistinguishable from an empty one.
      setMaxId(25);
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
      setMaxId(25);
      h.rowsFor.mockReturnValue([{ id: 1 }]);

      const res = await run({ entity: 'article', dryRun: 'false', batchSize: '10' });

      expect(res.body.results.article.batchErrors).toBe(0);
      expect(res.body.results.article.rowsChanged).toBe(3);
    });
  });
});

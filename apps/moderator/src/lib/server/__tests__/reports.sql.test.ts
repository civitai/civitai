import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportEntities, ReportReason, ReportStatus } from '$lib/reports';
import { explainHarness } from '../../../test/explain-harness';

/**
 * The same statements `reports.queries.explain.test.ts` plans — but asserted on the SQL text, so this
 * tier runs with NO DATABASE.
 *
 * That gap is why this file exists. The EXPLAIN tier is `describe.skipIf(!h.hasDb)` and CI has no
 * database, so `reports.service.ts`, whose subqueries are all raw `sql` assembled from
 * `REPORT_ENTITIES` with not one identifier typechecked, is unguarded on every CI run. Bulk Image Manager shipped a
 * raw-fragment defect through typecheck, lint and three review agents on 2026-08-21 (`4cf7034ea6`): it
 * emitted `where "i"."id" in SELECT …` and 500'd on every id. Only the emitted text sees that.
 *
 * 🔴 The expected table and column names are HARDCODED below, deliberately. Reading them from
 * `REPORT_ENTITIES` — which is what the service builds the query from — makes the assertion
 * self-referential: rename a table in that map and both the query and its expectation move together, so
 * the test can never fail. The first draft of this file did exactly that and passed a mutation that
 * pointed `post` at a table which does not exist.
 *
 * Assertions are on the parenthesised fragment SHAPE rather than on substrings, for the same reason: a
 * bare `contains "PostReport"` survives losing the parens that make the fragment legal SQL.
 */

const h = explainHarness();

vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
// The real cache helper with only the client stubbed: a permanent miss, so every call reaches the
// query this file is here to read.
vi.mock('../redis', () => ({
  getRedis: () => ({
    packed: { get: async () => null, set: async () => undefined },
    del: async () => 1,
    hmGet: async (_key: string, fields: string[]) => fields.map(() => null),
    hSetMultiWithExpire: async () => 1,
  }),
}));

const service = await import('../reports.service');

/** type → [report join table, foreign key]. Hardcoded on purpose — see the header. */
const EXPECTED: [string, string, string][] = [
  ['image', 'ImageReport', 'imageId'],
  ['model', 'ModelReport', 'modelId'],
  ['post', 'PostReport', 'postId'],
  ['article', 'ArticleReport', 'articleId'],
  ['comment', 'CommentReport', 'commentId'],
  ['commentV2', 'CommentV2Report', 'commentV2Id'],
  ['bounty', 'BountyReport', 'bountyId'],
  ['bountyEntry', 'BountyEntryReport', 'bountyEntryId'],
  ['collection', 'CollectionReport', 'collectionId'],
  ['resourceReview', 'ResourceReviewReport', 'resourceReviewId'],
  ['comicProject', 'ComicProjectReport', 'comicProjectId'],
  ['model3d', 'Model3DReport', 'model3dId'],
  ['model3dReview', 'Model3DReviewReport', 'model3dReviewId'],
  ['chat', 'ChatReport', 'chatId'],
  ['reportedUser', 'UserReport', 'userId'],
];

beforeEach(() => h.reset());

const emitted = () => {
  expect(h.queries.length).toBeGreaterThan(0);
  return h.queries.map((q) => q.sql);
};

/**
 * Every subquery in these statements is a raw fragment, and Kysely splices raw verbatim. Losing a
 * fragment's own parens yields `select select …` or `in select …` — legal-looking text that Postgres
 * rejects with 42601 before running anything.
 */
const noBareSubquery = (sql: string) => {
  expect(sql).not.toMatch(/\bin\s+select\b/i);
  expect(sql).not.toMatch(/\bexists\s+select\b/i);
  expect(sql).not.toMatch(/\bselect\s+select\b/i);
  expect(sql).not.toMatch(/,\s*select\b/i);
};

it('covers every entity the app declares', () => {
  // Guards the hardcoding: a new report type must be added here, not silently skipped.
  expect(EXPECTED.map(([type]) => type).sort()).toEqual([...reportEntities].sort());
});

describe('getReports', () => {
  it.each(EXPECTED)('%s selects its entity id from %s', async (type, table, fk) => {
    await service.getReports({
      type: type as (typeof reportEntities)[number],
      statuses: 'all',
      reasons: 'all',
    });

    const statements = emitted();
    // The page and its count. One would mean a predicate reached only one of them.
    expect(statements.length).toBeGreaterThanOrEqual(2);
    statements.forEach(noBareSubquery);

    // Both statements are gated on the join table existing, parens included.
    for (const sql of statements)
      expect(sql).toContain(`exists (select 1 from "${table}" er where er."reportId"`);

    // The id is selected by the page query only, and its subselect must be parenthesised.
    expect(statements.some((sql) => sql.includes(`(select er."${fk}" from "${table}" er`))).toBe(
      true
    );
  });
});

describe('getReportHistory', () => {
  it.each(EXPECTED)('%s resolves its entity id from %s', async (_type, table, fk) => {
    await service.getReportHistory(_type as (typeof reportEntities)[number]);

    const statements = emitted();
    statements.forEach(noBareSubquery);
    expect(statements.some((sql) => sql.includes(`(select er."${fk}" from "${table}" er`))).toBe(
      true
    );
  });
});

describe('the queries that fan out over every entity at once', () => {
  it('getReportCounts names all fifteen report tables', async () => {
    await service.getReportCounts();

    const [sql] = emitted();
    noBareSubquery(sql);
    // A branch dropped from the union is a queue that silently counts zero forever.
    for (const [, table] of EXPECTED) expect(sql).toContain(`"${table}"`);
  });

  it('getMostReported keeps every entity subselect parenthesised', async () => {
    await service.getMostReported({ limit: 10 });

    const statements = emitted();
    statements.forEach(noBareSubquery);
    for (const [, table, fk] of EXPECTED)
      expect(statements.some((sql) => sql.includes(`(SELECT er."${fk}" FROM "${table}" er`))).toBe(
        true
      );
  });
});

describe('getMostReportedPage', () => {
  it('counts exactly what it lists', async () => {
    await service.getMostReportedPage({ page: 2, limit: 25, days: 30 });

    // The list and the count are two statements carrying the same predicate by hand, so they can
    // drift — and a count that outruns its list renders page numbers that land on nothing.
    const [a, b] = emitted().map((sql) => sql.toLowerCase());
    const predicates = [a, b].map((sql) =>
      [
        sql.includes('t.status = '),
        sql.includes('array_length(t."alsoreportedby", 1), 0) + 1'),
        sql.includes('make_interval(days'),
        sql.includes('i."blockedfor" is null'),
      ].join()
    );
    expect(predicates[0]).toBe(predicates[1]);
    expect(predicates[0]).toBe('true,true,true,true');
  });

  it('pages inside the CTE, where the LIMIT already is', async () => {
    await service.getMostReportedPage({ page: 3, limit: 25, days: 7 });

    // OFFSET applied outside it would walk the discarded rows through all seventeen subplans — the
    // reason the LIMIT is in there in the first place.
    const list = emitted()
      .map((sql) => sql.toLowerCase())
      .find((sql) => sql.includes('with top as'))!;
    // `FROM top` opens the outer query, so an OFFSET after it is one applied to the joined result.
    expect(list.indexOf('offset')).toBeLessThan(list.indexOf('from top'));
  });
});

describe('report rows link to what was reported', () => {
  it('resolves a context url for every type that has no page of its own', async () => {
    await service.getMostReported({ limit: 10 });

    const statements = emitted();
    statements.forEach(noBareSubquery);
    // Hardcoded, like EXPECTED above: reading these from CONTEXT_ENTITIES — which is what the query
    // maps over — makes the assertion self-referential, so dropping a resolver would still pass.
    for (const column of [
      'context:comment',
      'context:commentV2',
      'context:bountyEntry',
      'context:model3dReview',
      'context:reportedUser',
    ])
      expect(statements.some((sql) => sql.includes('AS "' + column + '"'))).toBe(true);
  });

  it('falls back to the main app resolver for a commentV2 whose thread names no entity', async () => {
    await service.getMostReported({ limit: 10 });

    // 3,519 orphaned threads on the dev clone. Without the coalesce those rows render as dead text,
    // which is what the mod team reported as comment reports that link nowhere.
    const sql = emitted().find((s) => s.includes('context:commentV2'))!;
    expect(sql).toContain("'/comments/v2/' || cv.id");
    expect(sql.toLowerCase()).toContain('coalesce(case');
  });
});

describe('the filtered queue', () => {
  it('compiles with every filter applied at once', async () => {
    await service.getReports({
      type: 'image',
      page: 3,
      limit: 25,
      statuses: [ReportStatus.Pending, ReportStatus.Processing],
      reasons: [ReportReason.TOSViolation],
      reportedBy: 'someone',
      from: new Date('2026-08-01'),
      to: new Date('2026-08-20'),
    });

    emitted().forEach(noBareSubquery);
  });

  it('compiles the single-report view, which widens the filters', async () => {
    await service.getReports({ type: 'image', statuses: 'all', reasons: 'all', reportId: 42 });

    emitted().forEach(noBareSubquery);
  });
});

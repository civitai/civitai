import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportEntities, ReportReason, ReportStatus } from '$lib/reports';
import { explainHarness } from '../../../test/explain-harness';

/**
 * Every statement PLANNED against the live schema, none executed — see `src/test/explain-harness.ts`.
 *
 * Does NOT cover results: EXPLAIN cannot show that the `to` bound excludes, that `ilike` anchors as a
 * prefix, or that the offset paginates. Those need rows, and so a disposable database.
 */

const h = explainHarness();

// Both point at the same DummyDriver: nothing this file compiles can reach a connection.
vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));
vi.mock('../mod-activity', () => ({ recordModActivity: vi.fn() }));
vi.mock('../rewards', () => ({ rewardReportReporters: vi.fn() }));
// The real cache helper with only the client stubbed: a permanent miss, so every call reaches the
// query this file is here to plan.
vi.mock('../redis', () => ({
  getRedis: () => ({
    packed: { get: async () => null, set: async () => undefined },
    del: async () => 1,
    hmGet: async (_key: string, fields: string[]) => fields.map(() => null),
    hSetMultiWithExpire: async () => 1,
  }),
}));

const service = await import('../reports.service');

beforeEach(() => h.reset());
afterAll(() => h.destroy());

/** Plan everything the call compiled, and fail with the plan text if Postgres rejects a statement. */
async function plans() {
  const out = await h.explainAll();
  expect(out.length).toBeGreaterThan(0);
  return out;
}

describe.skipIf(!h.hasDb)('report queries plan against the real schema', () => {
  // Driven off `reportEntities` so a newly added type is covered without editing this file.
  it.each(reportEntities)('getReports(%s) — queue page and its count', async (type) => {
    await service.getReports({ type, statuses: 'all', reasons: 'all' });

    expect(h.queries.length).toBe(2);
    await plans();
  });

  it.each(reportEntities)('getReportHistory(%s)', async (type) => {
    await service.getReportHistory(type);
    await plans();
  });

  it('getReports with every filter applied at once', async () => {
    // Filters append to one builder, so a clash only reachable in combination needs them together.
    await service.getReports({
      type: 'image',
      page: 3,
      limit: 20,
      statuses: [ReportStatus.Pending, ReportStatus.Processing],
      reasons: [ReportReason.NSFW, ReportReason.TOSViolation],
      reportedBy: 'alice',
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-02-01T00:00:00Z'),
    });
    await plans();
  });

  // The only fragment that joins Thread to itself, and only these two types emit it.
  it.each(['comment', 'commentV2'] as const)(
    'getReports(%s) resolves the deep-link CASE over Thread',
    async (type) => {
      await service.getReports({ type, statuses: 'all', reasons: 'all' });
      const [, page] = h.queries;
      expect(page.sql).toMatch(/highlight/);
      await plans();
    }
  );

  it('getReportCounts — the materialized CTE and all fifteen union branches', async () => {
    await service.getReportCounts();

    const [counts] = h.queries;
    // Per-branch joins back to Report seq-scanned it once per entity type; hence the CTE.
    expect(counts.sql).toMatch(/with .*open_reports as materialized/i);
    expect(counts.sql.match(/union all/gi)).toHaveLength(reportEntities.length - 1);
    await plans();
  });

  it('getMostReportedPage — the same shape, paged, and its count', async () => {
    // The page adds an OFFSET inside that CTE and a second statement counting the same predicate.
    // Both plan here because neither is exercised by any other tier without a database.
    await service.getMostReportedPage({ page: 4, limit: 25, days: 30 });
    await plans();
  });
  it('getMostReported — the LIMIT-in-a-CTE shape with its seventeen subplans', async () => {
    // Subplans resolve OUTSIDE the CTE: Postgres cannot project through a Sort, so flattening this
    // evaluates them for every pending report of the week.
    await service.getMostReported({ limit: 10 });
    await plans();
  });
});

// Opt-in, so a checkout without a database must not read as covered. Runs either way.
describe('the EXPLAIN tier reports whether it ran', () => {
  it('is wired to a database, or is visibly skipped', () => {
    if (!h.hasDb) {
      console.warn(
        '[reports.queries.explain] no TEST_DATABASE_URL/DATABASE_URL — the report SQL was NOT planned.'
      );
    }
    expect(typeof h.hasDb).toBe('boolean');
  });
});

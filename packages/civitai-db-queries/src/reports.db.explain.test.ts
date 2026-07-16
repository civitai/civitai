import { afterAll, describe, expect, it } from 'vitest';
import { getReports, setReportStatus, setReportStatusMany, updateReportNotes } from './reports.db';
import { connectWithExplain } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. This never executes the
// statement — safe for the writes below — but it parses + plans it, so a query whose columns, joins, or
// types don't resolve against the real database fails here even though the compile-only test passed. Skips
// when no DB URL is available (see the harness). Stricter plan assertions (seq-scan / index usage) need a
// prod-like dataset and belong elsewhere; dev-DB planner choices vary with table size.
const h = connectWithExplain();

describe.skipIf(!h.hasDb)('reports queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getReports (both the count and items queries) plans against the real schema', async () => {
    await getReports({ type: 'model', statuses: ['Pending'], reasons: ['TOSViolation'], limit: 20 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('setReportStatus plans (write, not executed)', async () => {
    await setReportStatus({ id: -1, status: 'Actioned', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setReportStatusMany plans (write, not executed)', async () => {
    await setReportStatusMany({ ids: [-1, -2], status: 'Actioned', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateReportNotes plans (write, not executed)', async () => {
    await updateReportNotes({ id: -1, internalNotes: 'x' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

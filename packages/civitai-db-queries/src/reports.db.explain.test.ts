import { afterAll, describe, expect, it } from 'vitest';
import { getReports, setReportStatus, setReportStatusMany, updateReportNotes } from './reports.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the harness's compile-only `db` to each query (so it compiles without executing —
// safe for the writes below), then EXPLAIN (no ANALYZE) the compiled SQL against the live schema. This never
// runs the statement but parses + plans it, so a query whose columns/joins/types don't resolve fails here
// even though the compile-only test passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('reports queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getReports (both the count and items queries) plans against the real schema', async () => {
    await getReports(h.db, {
      type: 'model',
      statuses: ['Pending'],
      reasons: ['TOSViolation'],
      limit: 20,
    });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('setReportStatus plans (write, not executed)', async () => {
    await setReportStatus(h.db, { id: -1, status: 'Actioned', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setReportStatusMany plans (write, not executed)', async () => {
    await setReportStatusMany(h.db, { ids: [-1, -2], status: 'Actioned', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateReportNotes plans (write, not executed)', async () => {
    await updateReportNotes(h.db, { id: -1, internalNotes: 'x' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

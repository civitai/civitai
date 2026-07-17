import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createCsamReport,
  createExternalCsamReport,
  getCsamReportStats,
  getCsamReportsPaged,
  getCsamsToArchive,
  getCsamsToRemoveContent,
  getCsamsToReport,
  setCsamReportSent,
  updateCsamReport,
} from './csam.db';
import { explainHarness } from './test/harness';

// DB-backed tier: compile each query with the DummyDriver (so writes never execute) then EXPLAIN (no ANALYZE)
// the compiled SQL against the live schema — validating columns/joins/types resolve. Skips when no DB URL is
// available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('csam queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  beforeEach(() => {
    h.queries.length = 0;
  });

  it('createCsamReport plans (write, not executed)', async () => {
    await createCsamReport(h.db, {
      reportedById: -1,
      userId: -1,
      type: 'Image',
      imageIds: [-1],
      details: { minorDepiction: 'real' },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('createExternalCsamReport plans (write, not executed)', async () => {
    await createExternalCsamReport(h.db, {
      reportedById: -1,
      userId: -1,
      details: { email: 'a@b.com' },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getCsamReportsPaged (paged read + count) plans against the real schema', async () => {
    await getCsamReportsPaged(h.db, { limit: 20, page: 1 });
    const plans = await h.explainAll();
    // The DummyDriver report read resolves empty, so the user hydration is skipped: paged read + count.
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getCsamReportStats (three counts) plans against the real schema', async () => {
    await getCsamReportStats(h.db);
    const plans = await h.explainAll();
    expect(plans).toHaveLength(3);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getCsamsToReport plans', async () => {
    await getCsamsToReport(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getCsamsToArchive plans', async () => {
    await getCsamsToArchive(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getCsamsToRemoveContent plans', async () => {
    await getCsamsToRemoveContent(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setCsamReportSent plans (write, not executed)', async () => {
    await setCsamReportSent(h.db, { id: -1, reportId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateCsamReport plans (write, not executed)', async () => {
    await updateCsamReport(h.db, { id: -1, archivedAt: new Date() });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

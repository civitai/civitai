import { afterAll, describe, expect, it } from 'vitest';
import {
  getReportById,
  getReportByIds,
  getReports,
  insertReport,
  insertReportEntity,
  setReportStatus,
  setReportStatusMany,
  updateImageReportStatusByReason,
  updateReport,
  upsertImageRatingRequest,
} from './report.db';
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

  it('getReportById plans', async () => {
    await getReportById(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getReportByIds plans', async () => {
    await getReportByIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateReport plans (write, not executed)', async () => {
    await updateReport(h.db, { id: -1, status: 'Actioned' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateImageReportStatusByReason plans (write, not executed)', async () => {
    await updateImageReportStatusByReason(h.db, { id: -1, reason: 'CSAM', status: 'Actioned' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertReport plans (write, not executed)', async () => {
    // executeTakeFirstOrThrow rejects on the empty compile result; the query is still compiled + captured.
    await insertReport(h.db, {
      userId: -1,
      reason: 'NSFW',
      status: 'Actioned',
      details: { tags: ['a'] },
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertReportEntity plans (write, not executed)', async () => {
    await insertReportEntity(h.db, { type: 'image', reportId: -1, entityId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertImageRatingRequest plans (write, not executed)', async () => {
    await upsertImageRatingRequest(h.db, { imageId: -1, userId: -1, nsfwLevel: 8 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

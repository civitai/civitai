import { afterAll, describe, expect, it } from 'vitest';
import {
  countScannerLabelReviewsByUser,
  getScannerContentImages,
  getScannerContentSnapshots,
  getScannerLabelReviewStats,
  getScannerLabelReviewVerdicts,
  getScannerLabelReviewsByUser,
  insertScannerContentSnapshot,
  upsertScannerLabelVerdict,
} from './scanner.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. This never executes the
// statement — safe for the writes below — but it parses + plans it, so a query whose columns, joins, or
// types don't resolve against the real database fails here even though the compile-only test passed. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('scanner queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getScannerLabelReviewStats plans', async () => {
    await getScannerLabelReviewStats(h.db, { scanner: 'xguard_text' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getScannerLabelReviewVerdicts plans', async () => {
    await getScannerLabelReviewVerdicts(h.db, [{ contentHash: 'h1', version: 'v1', label: 'l1' }]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('countScannerLabelReviewsByUser plans', async () => {
    await countScannerLabelReviewsByUser(h.db, { userId: -1, label: 'l', since: new Date(0) });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getScannerLabelReviewsByUser plans', async () => {
    await getScannerLabelReviewsByUser(h.db, {
      userId: -1,
      label: 'l',
      contentHashes: ['h1', 'h2'],
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertScannerLabelVerdict plans (write, not executed)', async () => {
    await upsertScannerLabelVerdict(h.db, {
      contentHash: 'h1',
      version: 'v1',
      label: 'l',
      verdict: 'Unsure',
      userId: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertScannerContentSnapshot plans (write, not executed)', async () => {
    await insertScannerContentSnapshot(h.db, {
      contentHash: 'h1',
      scanner: 'xguard_text',
      body: { text: 'hi' },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getScannerContentSnapshots plans', async () => {
    await getScannerContentSnapshots(h.db, ['h1', 'h2']);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getScannerContentImages plans', async () => {
    await getScannerContentImages(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

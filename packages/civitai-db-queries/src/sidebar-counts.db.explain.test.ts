import { afterAll, describe, expect, it } from 'vitest';
import {
  countImageAppeals,
  countPendingImageTagReviews,
  countReportsPending,
} from './sidebar-counts.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported count against the live schema. Never executes the
// statement; it parses + plans it, so a query whose columns/types don't resolve against the real database
// fails here even though the compile-only test passed. Crucial for the raw bitmask predicates, which the
// compile tier cannot validate against the real `attributes` column. Skips when no DB URL is available.
const h = explainHarness();

describe.skipIf(!h.hasDb)('sidebar-counts queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('countPendingImageTagReviews plans (validates the bitmask predicates against the real schema)', async () => {
    await countPendingImageTagReviews(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('countImageAppeals plans against the real schema', async () => {
    await countImageAppeals(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('countReportsPending plans against the real schema', async () => {
    await countReportsPending(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

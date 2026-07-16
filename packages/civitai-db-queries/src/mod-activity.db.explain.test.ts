import { afterAll, describe, expect, it } from 'vitest';
import { recordModActivity } from './mod-activity.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) the ported upsert against the live schema. This never executes the
// statement — safe for the write — but it parses + plans it, so a query whose columns, conflict target, or
// types don't resolve against the real database fails here even though the compile-only test passed. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('mod-activity queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('recordModActivity plans (write, not executed)', async () => {
    await recordModActivity(h.db, {
      userId: -1,
      entityType: 'image',
      entityId: -1,
      activity: 'review',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

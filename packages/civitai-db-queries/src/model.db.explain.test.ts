import { afterAll, describe, expect, it } from 'vitest';
import { explainHarness } from './test/harness';
import { listModelEngagements } from './model.db';

const h = explainHarness();

afterAll(() => h.destroy());

// DB-backed tier: EXPLAIN (no ANALYZE) parses + plans against the live schema without executing, so a
// column, type or enum that doesn't resolve fails here even though the compile test passed. Skips when
// no DB is reachable.
describe.skipIf(!h.hasDb)('model.db queries EXPLAIN against the real schema', () => {
  it('listModelEngagements plans', async () => {
    await listModelEngagements(h.db, { userId: 1, modelIds: [1, 2] });
    expect(await h.explainLast()).toBeTruthy();
  });
});

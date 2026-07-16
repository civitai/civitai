import { afterAll, describe, expect, it } from 'vitest';
import { getGlobalRewardsBonus } from './rewards.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) the ported read against the live schema — parses + plans it without
// executing, so a query whose columns/types don't resolve against the real database fails here even though
// the compile-only test passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('rewards queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getGlobalRewardsBonus plans against the real schema', async () => {
    await getGlobalRewardsBonus(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

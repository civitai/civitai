import { afterAll, describe, expect, it } from 'vitest';
import { deleteBountyEntryForUser, deleteBountyForUser } from './bounty.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` (so writes compile but never execute), then EXPLAIN the compiled
// SQL against the live schema. Validates that every ported query's columns/joins/types/enums resolve. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('bounty queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('deleteBountyEntryForUser (not-exists benefactors) plans', async () => {
    await deleteBountyEntryForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteBountyForUser plans', async () => {
    await deleteBountyForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

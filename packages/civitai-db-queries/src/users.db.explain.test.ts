import { afterAll, describe, expect, it } from 'vitest';
import { searchUsers } from './users.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — validates that the
// columns/joins/types resolve against the real database without executing the statement. Skips when no DB
// URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('users queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('searchUsers plans against the real schema', async () => {
    await searchUsers(h.db, { query: 'a', limit: 5 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

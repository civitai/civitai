import { afterAll, describe, expect, it } from 'vitest';
import { deleteResourceReviewForUser } from './resource-review.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` (so writes compile but never execute), then EXPLAIN the compiled
// SQL against the live schema. Validates that every ported query's columns/joins/types/enums resolve. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('resource-review queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('deleteResourceReviewForUser plans', async () => {
    await deleteResourceReviewForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

import { afterAll, describe, expect, it } from 'vitest';
import { getModel3DsByThumbnailImageIds, unpublishModel3d } from './model3d.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. This never executes the
// statement — safe for the write below — but it parses + plans it, so a query whose columns, joins, or types
// don't resolve against the real database fails here even though the compile-only test passed. Skips when no
// DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('model3d queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getModel3DsByThumbnailImageIds plans against the real schema', async () => {
    await getModel3DsByThumbnailImageIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModel3d plans (write, not executed)', async () => {
    await unpublishModel3d(h.db, { id: -1, userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

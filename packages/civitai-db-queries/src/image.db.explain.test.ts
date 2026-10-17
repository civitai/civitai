import { afterAll, describe, expect, it } from 'vitest';
import { explainHarness } from './test/harness';
import { getImageGenerationFields } from './image.db';

const h = explainHarness();

afterAll(() => h.destroy());

// DB-backed tier: EXPLAIN (no ANALYZE) parses + plans against the live schema without executing, so a
// column, type or join that doesn't resolve fails here even though the compile test passed. Skips when
// no DB is reachable.
describe.skipIf(!h.hasDb)('image.db queries EXPLAIN against the real schema', () => {
  it('getImageGenerationFields plans, reading Image by its primary key', async () => {
    await getImageGenerationFields(h.db, 1);
    const plan = await h.explainLast();
    // Planner choices for the small joined tables vary with statistics, so only the outer lookup is
    // pinned: one image by id must never become a scan of the whole table.
    expect(plan).toMatch(/Index (Only )?Scan using "Image_pkey" on "Image"/);
    expect(plan).not.toMatch(/Seq Scan on "Image"/);
  });
});

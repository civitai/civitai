import { afterAll, describe, expect, it } from 'vitest';
import { explainHarness } from './test/harness';
import { getImageGenerationFields } from './image.db';

const h = explainHarness();

afterAll(() => h.destroy());

// DB-backed tier: EXPLAIN (no ANALYZE) parses + plans against the live schema without executing, so a
// column, type or join that doesn't resolve fails here even though the compile test passed. Skips when
// no DB is reachable.
describe.skipIf(!h.hasDb)('image.db queries EXPLAIN against the real schema', () => {
  it('getImageGenerationFields plans', async () => {
    await getImageGenerationFields(h.db, 1);
    expect(await h.explainLast()).toBeTruthy();
  });
});

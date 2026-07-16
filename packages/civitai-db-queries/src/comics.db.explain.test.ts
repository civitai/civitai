import { afterAll, describe, expect, it } from 'vitest';
import { getComicReviewQueue } from './comics.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) the ported query against the live schema so a column/join/type that
// does not resolve against the real database fails here even though the compile-only test passed. Skips when
// no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('comics queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getComicReviewQueue (default branch) plans against the real schema', async () => {
    await getComicReviewQueue(h.db, { limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (specific needsReview) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, needsReview: 'poi' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (includeTosViolations=false) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, includeTosViolations: false });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (with cursor) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, cursor: 555 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

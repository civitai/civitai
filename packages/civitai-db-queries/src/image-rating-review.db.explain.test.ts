import { afterAll, describe, expect, it } from 'vitest';
import { getImageRatingRequests, getImageRatingReviewCount } from './image-rating-review.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. These are fully raw SQL, so
// this is the real safety net — a bad column, missing enum, or mistyped cast that the compile-only suite can't
// see fails here. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('image-rating-review queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getImageRatingRequests plans (no cursor)', async () => {
    await getImageRatingRequests(h.db, { limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageRatingRequests plans (with cursor)', async () => {
    await getImageRatingRequests(h.db, { cursor: 1, limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageRatingReviewCount plans', async () => {
    await getImageRatingReviewCount(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

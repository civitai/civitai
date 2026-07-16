import { afterAll, describe, expect, it } from 'vitest';
import {
  getImageTagReviewImages,
  getImageTagReviewTags,
  getImageTagsNeedingReview,
} from './image-tags.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. These are fully raw SQL, so
// this is the real safety net — a bad column, missing enum, or a bitmask cast the planner can't match fails
// here even though the compile-only suite passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('image-tags queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getImageTagReviewImages plans (no cursor) — bitmask predicates match the partial indexes', async () => {
    await getImageTagReviewImages(h.db, { limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageTagReviewImages plans (with cursor)', async () => {
    await getImageTagReviewImages(h.db, { cursor: 1, limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageTagReviewTags plans — vote aggregation over TagsOnImageVote', async () => {
    await getImageTagReviewTags(h.db, [1, 2, 3]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageTagsNeedingReview plans', async () => {
    await getImageTagsNeedingReview(h.db, { imageId: 1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

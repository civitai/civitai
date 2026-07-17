import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createImageTagsForReview,
  deleteImagTagsForReviewByImageIds,
  disableTags,
  getImagTagsForReviewByImageIds,
  getImageTagReviewImages,
  getImageTagReviewTags,
  getImageTagsNeedingReview,
  getTagsForReview,
  moderateTags,
} from './image-tags.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. These are fully raw SQL, so
// this is the real safety net — a bad column, missing enum, or a bitmask cast the planner can't match fails
// here even though the compile-only suite passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('image-tags queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());
  beforeEach(() => {
    h.queries.length = 0; // explainAll explains every captured query — isolate each test's statements
  });

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

  it('getTagsForReview plans both the tags and count queries', async () => {
    await getTagsForReview(h.db, { reviewType: 'minor', take: 20, skip: 0 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('moderateTags (image) plans the needsReview select', async () => {
    await moderateTags(h.db, { entityIds: [-1, -2], entityType: 'image', disable: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  // NOTE: no EXPLAIN case for disableTags entityType: 'model' — the source references a nonexistent
  // "disabled" column on "TagsOnModels" (its own `TODO.fix` flags this), so that branch cannot plan against
  // the real schema. The compile-only suite still asserts the ported SQL shape.

  it('disableTags (image, tag names) plans the TagsOnImageDetails select', async () => {
    await disableTags(h.db, { tags: ['nudity'], entityIds: [-1], entityType: 'image' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('disableTags (tag, tag ids) plans the TagsOnTags delete', async () => {
    await disableTags(h.db, { tags: [-1], entityIds: [-1], entityType: 'tag' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('createImageTagsForReview plans the insert', async () => {
    await createImageTagsForReview(h.db, { imageId: -1, tagIds: [-1, -2] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteImagTagsForReviewByImageIds plans the delete', async () => {
    await deleteImagTagsForReviewByImageIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImagTagsForReviewByImageIds plans the select', async () => {
    await getImagTagsForReviewByImageIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

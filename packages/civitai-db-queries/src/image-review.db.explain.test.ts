import { afterAll, describe, expect, it } from 'vitest';
import {
  getAppealImageQueue,
  getImageReviewCounts,
  getImageReviewQueue,
  getImagesModRules,
  getModerationRuleDefinitions,
  getModeratorPOITags,
  getReportedImageQueue,
  getReviewQueueTags,
} from './image-review.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — parses + plans without
// executing, so a query whose columns/joins/types don't resolve against the real database fails here even
// though the compile-only test passed. Skips when no DB URL is available. Note: the queue functions issue a
// second (tag/report hydration) query only when the first returns rows; against the compile driver the first
// resolves empty, so only the primary query is captured/explained here.
const h = explainHarness();

describe.skipIf(!h.hasDb)('image-review queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getImageReviewQueue plans (with tag include/exclude, cursor, browsing level)', async () => {
    await getImageReviewQueue(h.db, {
      needsReview: 'minor',
      tagIds: [1, 2],
      excludedTagIds: [3],
      browsingLevel: 31,
      cursor: 1_000_000,
      limit: 20,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModerationRuleDefinitions plans', async () => {
    await getModerationRuleDefinitions(h.db, [1, 2, 3]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getReviewQueueTags plans', async () => {
    await getReviewQueueTags(h.db, 'tag');
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageReviewCounts plans', async () => {
    await getImageReviewCounts(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getReportedImageQueue plans', async () => {
    await getReportedImageQueue(h.db, { browsingLevel: 31, cursor: 1, limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getAppealImageQueue plans', async () => {
    await getAppealImageQueue(h.db, { browsingLevel: 31, cursor: 1_000_000, limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImagesModRules plans', async () => {
    await getImagesModRules(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModeratorPOITags plans', async () => {
    await getModeratorPOITags(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

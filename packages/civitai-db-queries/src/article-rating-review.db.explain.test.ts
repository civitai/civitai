import { afterAll, describe, expect, it } from 'vitest';
import {
  computeArticleDerivedNsfwLevel,
  getArticleCoverImages,
  getArticleLockState,
  getArticleRatingReviewCounts,
  getArticleRatingReviewForResolve,
  getArticleRatingReviews,
  setArticleModeratorLevel,
  setArticleRatingReviewResolved,
} from './article-rating-review.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported statement against the live schema. This never executes the
// statement — safe for the writes below — but it parses + plans it, so a query whose columns/joins/types don't
// resolve against the real database fails here even though the compile-only test passed. Each statement is
// exercised on its own so the whole resolve path is validated piece by piece. Skips when no DB URL is present.
const h = explainHarness();

describe.skipIf(!h.hasDb)('article-rating-review queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getArticleRatingReviews (main paged query) plans', async () => {
    await getArticleRatingReviews(h.db, { status: 'Pending', limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleCoverImages plans', async () => {
    await getArticleCoverImages(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleRatingReviewCounts plans', async () => {
    await getArticleRatingReviewCounts(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('computeArticleDerivedNsfwLevel plans (preserves the raw derived-level fragments)', async () => {
    await computeArticleDerivedNsfwLevel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleRatingReviewForResolve plans', async () => {
    await getArticleRatingReviewForResolve(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleRatingReviewResolved plans (write, not executed)', async () => {
    await setArticleRatingReviewResolved(h.db, {
      reviewId: -1,
      status: 'Actioned',
      appliedLevel: 4,
      moderatorId: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleLockState plans', async () => {
    await getArticleLockState(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleModeratorLevel plans (write, not executed)', async () => {
    await setArticleModeratorLevel(h.db, {
      articleId: -1,
      appliedLevel: 4,
      basis: 0,
      lockedProperties: ['userNsfwLevel'],
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

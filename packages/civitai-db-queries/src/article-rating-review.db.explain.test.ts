import { afterAll, describe, expect, it } from 'vitest';
import {
  clearArticleModeratorLevel,
  computeArticleDerivedNsfwLevel,
  countArticleProblematicContentImages,
  getArticleCoverImages,
  getArticleForRatingReview,
  getArticleLockState,
  getArticleRatingReviewById,
  getArticleRatingReviewCounts,
  getArticleRatingReviewForResolve,
  getArticleRatingReviews,
  getLastResolvedArticleRatingReview,
  getLatestArticleRatingReview,
  getPendingArticleRatingReviewByArticle,
  insertArticleRatingReview,
  insertAutoResolvedArticleRatingReview,
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

  it('getArticleForRatingReview plans', async () => {
    await getArticleForRatingReview(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getPendingArticleRatingReviewByArticle plans', async () => {
    await getPendingArticleRatingReviewByArticle(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getLastResolvedArticleRatingReview plans', async () => {
    await getLastResolvedArticleRatingReview(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getLatestArticleRatingReview plans', async () => {
    await getLatestArticleRatingReview(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('countArticleProblematicContentImages plans', async () => {
    await countArticleProblematicContentImages(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertArticleRatingReview plans (write, not executed)', async () => {
    await insertArticleRatingReview(h.db, {
      articleId: -1,
      userId: -1,
      currentLevel: 8,
      suggestedLevel: 2,
      userComment: null,
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleRatingReviewById plans', async () => {
    await getArticleRatingReviewById(h.db, -1).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertAutoResolvedArticleRatingReview plans (write, not executed)', async () => {
    await insertAutoResolvedArticleRatingReview(h.db, {
      articleId: -1,
      userId: -1,
      currentLevel: 8,
      suggestedLevel: 2,
      userComment: null,
      resolvedBy: -1,
      modComment: 'Auto-approved: rescan matched requested rating',
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('clearArticleModeratorLevel plans (write, not executed)', async () => {
    await clearArticleModeratorLevel(h.db, {
      articleId: -1,
      userNsfwLevel: 2,
      lockedProperties: [],
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});

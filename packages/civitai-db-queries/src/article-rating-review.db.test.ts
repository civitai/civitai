import { beforeEach, describe, expect, it } from 'vitest';
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
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getArticleRatingReviews', () => {
  it('joins owner/resolver/article, filters by status, newest-first, limit/offset', async () => {
    await getArticleRatingReviews(harness.db, { status: 'Pending', page: 2, limit: 20 });
    // With the DummyDriver the main query returns no rows, so the covers query never fires — the main
    // query is the only (and last) one captured.
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "ArticleRatingReview"');
    expect(sql).toContain(
      'inner join "User" as "owner" on "owner"."id" = "ArticleRatingReview"."userId"'
    );
    expect(sql).toContain(
      'left join "User" as "resolver" on "resolver"."id" = "ArticleRatingReview"."resolvedBy"'
    );
    expect(sql).toContain(
      'inner join "Article" on "Article"."id" = "ArticleRatingReview"."articleId"'
    );
    expect(sql).toContain('"ArticleRatingReview"."status" = $1');
    expect(sql).toContain('order by "ArticleRatingReview"."id" desc');
    expect(sql).toContain('limit $2');
    expect(sql).toContain('offset $3');
    // status, limit, offset=(page-1)*limit
    expect(parameters).toEqual(['Pending', 20, 20]);
  });

  it('runs only the main query when there are no rows (covers query short-circuits)', async () => {
    await getArticleRatingReviews(harness.db, { status: 'Actioned' });
    expect(harness.queries).toHaveLength(1);
  });
});

describe('getArticleCoverImages', () => {
  it('selects id/url/type for the given ids', async () => {
    await getArticleCoverImages(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "id", "url", "type" from "Image" where "id" in ($1, $2, $3)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });

  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getArticleCoverImages(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });
});

describe('getArticleRatingReviewCounts', () => {
  it('groups by status', async () => {
    await getArticleRatingReviewCounts(harness.db);
    const { sql } = harness.lastQuery();

    expect(sql).toBe(
      'select "ArticleRatingReview"."status", count(*) as "count" ' +
        'from "ArticleRatingReview" group by "ArticleRatingReview"."status"'
    );
  });
});

describe('computeArticleDerivedNsfwLevel', () => {
  it('binds the articleId and preserves the derived-level raw fragments', async () => {
    await computeArticleDerivedNsfwLevel(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();

    // articleId bound twice (level CTE + moderation_floor CTE).
    expect(parameters).toEqual([42, 42]);
    expect(sql).toContain('GREATEST');
    expect(sql).toContain(`'Succeeded'::"EntityModerationStatus"`);
    expect(sql).toContain(`'nsfw' = ANY(em."triggeredLabels")`);
    expect(sql).toContain(`r.reason = 'NSFW'::"ReportReason"`);
    expect(sql).toContain(`r.status = 'Actioned'::"ReportStatus"`);
    expect(sql).toContain('SELECT GREATEST(level."nsfwLevel", mf."floor") AS derived');
  });
});

describe('getArticleRatingReviewForResolve', () => {
  it('selects the pending review row, status-guarded', async () => {
    await getArticleRatingReviewForResolve(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "articleId", "userId", "currentLevel", "suggestedLevel" ' +
        'from "ArticleRatingReview" where "id" = $1 and "status" = $2'
    );
    expect(parameters).toEqual([7, 'Pending']);
  });
});

describe('setArticleRatingReviewResolved', () => {
  it('stamps status/resolver/appliedLevel/modComment, guarded on Pending', async () => {
    await setArticleRatingReviewResolved(harness.db, {
      reviewId: 7,
      status: 'Actioned',
      appliedLevel: 4,
      modComment: 'ok',
      moderatorId: 99,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "ArticleRatingReview" set "status" = $1, "resolvedAt" = $2, "resolvedBy" = $3, ' +
        '"appliedLevel" = $4, "modComment" = $5 where "id" = $6 and "status" = $7'
    );
    expect(parameters[0]).toBe('Actioned');
    expect(parameters[1]).toBeInstanceOf(Date); // resolvedAt stamped explicitly
    expect(parameters[2]).toBe(99);
    expect(parameters[3]).toBe(4);
    expect(parameters[4]).toBe('ok');
    expect(parameters[5]).toBe(7);
    expect(parameters[6]).toBe('Pending');
  });

  it('defaults modComment to null when omitted', async () => {
    await setArticleRatingReviewResolved(harness.db, {
      reviewId: 7,
      status: 'Unactioned',
      appliedLevel: 2,
      moderatorId: 99,
    });
    const { parameters } = harness.lastQuery();
    expect(parameters[4]).toBeNull();
  });
});

describe('getArticleLockState', () => {
  it('selects lockedProperties + title for the article', async () => {
    await getArticleLockState(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "lockedProperties", "title" from "Article" where "id" = $1');
    expect(parameters).toEqual([5]);
  });
});

describe('setArticleModeratorLevel', () => {
  it('writes the override level/basis and the locked-properties array (text[], not jsonb)', async () => {
    await setArticleModeratorLevel(harness.db, {
      articleId: 5,
      appliedLevel: 4,
      basis: 2,
      lockedProperties: ['userNsfwLevel'],
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "moderatorNsfwLevel" = $1, "moderatorNsfwLevelBasis" = $2, ' +
        '"nsfwLevel" = $3, "lockedProperties" = $4 where "id" = $5'
    );
    // lockedProperties passes through as a JS array (Postgres text[]); no ::jsonb cast and no updatedAt.
    expect(sql).not.toContain('jsonb');
    expect(sql).not.toContain('updatedAt');
    expect(parameters).toEqual([4, 2, 4, ['userNsfwLevel'], 5]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
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
        '"nsfwLevel" = $3, "lockedProperties" = $4, "updatedAt" = $5 where "id" = $6'
    );
    // lockedProperties passes through as a JS array (Postgres text[]); no ::jsonb cast. updatedAt is
    // plugin-stamped (Article is @updatedAt and the Prisma source bumped it).
    expect(sql).not.toContain('jsonb');
    expect(parameters).toEqual([4, 2, 4, ['userNsfwLevel'], expect.any(Date), 5]);
  });
});

describe('getArticleForRatingReview', () => {
  it('selects the ownership + auto-approve-gate fields', async () => {
    await getArticleForRatingReview(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "userId", "nsfwLevel", "updatedAt", "status", "ingestion", ' +
        '"moderatorNsfwLevel", "moderatorNsfwLevelBasis", "coverId", "title" ' +
        'from "Article" where "id" = $1'
    );
    expect(parameters).toEqual([5]);
  });
});

describe('getPendingArticleRatingReviewByArticle', () => {
  it('selects the pending dispute for the article, status-guarded', async () => {
    await getPendingArticleRatingReviewByArticle(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "userId", "suggestedLevel", "currentLevel" ' +
        'from "ArticleRatingReview" where "articleId" = $1 and "status" = $2'
    );
    expect(parameters).toEqual([5, 'Pending']);
  });
});

describe('getLastResolvedArticleRatingReview', () => {
  it('selects the most recently resolved dispute (Actioned/Unactioned, resolvedAt set)', async () => {
    await getLastResolvedArticleRatingReview(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "resolvedAt" from "ArticleRatingReview" ' +
        'where "articleId" = $1 and "status" in ($2, $3) and "resolvedAt" is not null ' +
        'order by "resolvedAt" desc'
    );
    expect(parameters).toEqual([5, 'Actioned', 'Unactioned']);
  });
});

describe('getLatestArticleRatingReview', () => {
  it('selects the newest dispute of any status for the owner badge', async () => {
    await getLatestArticleRatingReview(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "status", "createdAt", "resolvedAt", "currentLevel", "suggestedLevel", ' +
        '"appliedLevel", "userComment", "modComment" from "ArticleRatingReview" ' +
        'where "articleId" = $1 order by "createdAt" desc'
    );
    expect(parameters).toEqual([5]);
  });
});

describe('countArticleProblematicContentImages', () => {
  it('counts content images NOT in a clean scanned state', async () => {
    await countArticleProblematicContentImages(harness.db, 5);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select count(*) as "count" from "ImageConnection" as "ic" ' +
        'inner join "Image" as "i" on "i"."id" = "ic"."imageId" ' +
        'where "ic"."entityId" = $1 and "ic"."entityType" = $2 ' +
        'and "i"."ingestion" in ($3, $4, $5, $6, $7, $8)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([
      5,
      'Article',
      'Pending',
      'Rescan',
      'PendingManualAssignment',
      'Blocked',
      'Error',
      'NotFound',
    ]);
  });
});

describe('insertArticleRatingReview', () => {
  it('inserts a Pending dispute (no updatedAt column, default createdAt)', async () => {
    // executeTakeFirstOrThrow rejects on the empty DummyDriver result, but the query is logged first.
    await insertArticleRatingReview(harness.db, {
      articleId: 5,
      userId: 42,
      currentLevel: 8,
      suggestedLevel: 2,
      userComment: 'too high',
    }).catch(() => {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('insert into "ArticleRatingReview"');
    expect(sql).toContain('returning *');
    expect(sql).not.toContain('updatedAt');
    expect(parameters).toEqual([5, 42, 8, 2, 'too high', 'Pending']);
  });
});

describe('getArticleRatingReviewById', () => {
  it('selects the full dispute row by id', async () => {
    await getArticleRatingReviewById(harness.db, 7).catch(() => {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "articleId", "userId", "currentLevel", "suggestedLevel", "appliedLevel", ' +
        '"userComment", "modComment", "status", "createdAt", "resolvedAt", "resolvedBy" ' +
        'from "ArticleRatingReview" where "id" = $1'
    );
    expect(parameters).toEqual([7]);
  });
});

describe('insertAutoResolvedArticleRatingReview', () => {
  it('inserts an Actioned row with appliedLevel, resolvedAt/By, and the mod comment', async () => {
    await insertAutoResolvedArticleRatingReview(harness.db, {
      articleId: 5,
      userId: 42,
      currentLevel: 8,
      suggestedLevel: 2,
      userComment: 'too high',
      resolvedBy: -1,
      modComment: 'Auto-approved: rescan matched requested rating',
    }).catch(() => {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('insert into "ArticleRatingReview"');
    expect(sql).toContain('returning "id"');
    // articleId, userId, currentLevel, suggestedLevel, userComment, status, appliedLevel, resolvedAt, resolvedBy, modComment
    expect(parameters[0]).toBe(5);
    expect(parameters[5]).toBe('Actioned');
    expect(parameters[6]).toBe(2); // appliedLevel = suggestedLevel
    expect(parameters[7]).toBeInstanceOf(Date); // resolvedAt stamped
    expect(parameters[8]).toBe(-1); // resolvedBy (system user)
    expect(parameters[9]).toBe('Auto-approved: rescan matched requested rating');
  });
});

describe('clearArticleModeratorLevel', () => {
  it('nulls the override + basis, pins userNsfwLevel, writes the locked set, bumps updatedAt', async () => {
    await clearArticleModeratorLevel(harness.db, {
      articleId: 5,
      userNsfwLevel: 2,
      lockedProperties: [],
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "moderatorNsfwLevel" = $1, "moderatorNsfwLevelBasis" = $2, ' +
        '"userNsfwLevel" = $3, "lockedProperties" = $4, "updatedAt" = $5 where "id" = $6'
    );
    expect(sql).not.toContain('jsonb');
    expect(parameters[0]).toBeNull();
    expect(parameters[1]).toBeNull();
    expect(parameters[2]).toBe(2);
    expect(parameters[3]).toEqual([]);
    expect(parameters[4]).toBeInstanceOf(Date);
    expect(parameters[5]).toBe(5);
  });
});

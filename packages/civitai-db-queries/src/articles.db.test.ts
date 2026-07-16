import { beforeEach, describe, expect, it } from 'vitest';
import {
  countArticlesForModeration,
  deleteArticleFiles,
  deleteArticleImageConnections,
  deleteArticleRecord,
  getArticleContentImageIngestion,
  getArticleCoverIngestion,
  getArticleForRestore,
  getArticleTextModeration,
  getArticlesForModeration,
  refreshArticleNsfwLevel,
  setArticleIngestion,
  setArticleRestored,
} from './articles.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getArticlesForModeration', () => {
  it('filters to the explicit status and an author substring when both are given', async () => {
    await getArticlesForModeration(harness.db, {
      page: 2,
      limit: 20,
      username: 'alice',
      status: 'Unpublished',
    });
    // Runs a count then the items query; the items query is last.
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Article"');
    expect(sql).toContain('inner join "User" on "User"."id" = "Article"."userId"');
    expect(sql).toContain('left join "Image" on "Image"."id" = "Article"."coverId"');
    expect(sql).toContain('"Article"."status" in ($1)');
    expect(sql).toContain('"User"."username" ilike $2');
    expect(sql).toContain('order by "Article"."createdAt" desc');
    expect(sql).toContain('limit $3');
    expect(sql).toContain('offset $4');
    // explicit status, username substring, limit, offset=(page-1)*limit
    expect(parameters).toEqual(['Unpublished', '%alice%', 20, 20]);
  });

  it('falls back to the unpublished set and omits the username filter when both are absent', async () => {
    await getArticlesForModeration(harness.db, {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).not.toContain('ilike');
    expect(sql).toContain('"Article"."status" in ($1, $2)');
    // both unpublished statuses, then the default limit/offset
    expect(parameters).toEqual(['Unpublished', 'UnpublishedViolation', 20, 0]);
  });
});

describe('countArticlesForModeration', () => {
  it('counts the unpublished set with no username filter', async () => {
    await countArticlesForModeration(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Article"');
    expect(sql).toContain('"status" in ($1, $2)');
    expect(sql).not.toContain('ilike');
    expect(parameters).toEqual(['Unpublished', 'UnpublishedViolation']);
  });
});

describe('getArticleForRestore', () => {
  it('selects the fields needed to restore and recompute ingestion', async () => {
    await getArticleForRestore(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "status", "publishedAt", "metadata", "userId", "coverId", "title", "content", "ingestion" ' +
        'from "Article" where "id" = $1'
    );
    expect(parameters).toEqual([7]);
  });
});

describe('setArticleRestored', () => {
  it('publishes with the preserved publishedAt and jsonb metadata', async () => {
    const publishedAt = new Date('2024-01-01T00:00:00.000Z');
    await setArticleRestored(harness.db, { id: 7, publishedAt, metadata: { a: 1 } });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "status" = $1, "publishedAt" = $2, "metadata" = $3::jsonb where "id" = $4'
    );
    expect(parameters[0]).toBe('Published');
    expect(parameters[1]).toBe(publishedAt);
    expect(parameters[2]).toBe('{"a":1}');
    expect(parameters[3]).toBe(7);
  });
});

describe('refreshArticleNsfwLevel', () => {
  it('emits the nsfwLevel re-derive CTE with the moderation floor and passes id twice', async () => {
    await refreshArticleNsfwLevel(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('GREATEST');
    expect(sql).toContain(`'nsfw' = ANY(em."triggeredLabels")`);
    expect(sql).toContain(`em.status = 'Succeeded'::"EntityModerationStatus"`);
    expect(sql).toContain(`r.reason = 'NSFW'::"ReportReason"`);
    expect(sql).toContain(`r.status = 'Actioned'::"ReportStatus"`);
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('a."moderatorNsfwLevel"');
    // id is referenced in both the `level` and `moderation_floor` CTEs
    expect(parameters).toEqual([7, 7]);
  });
});

describe('getArticleContentImageIngestion', () => {
  it('reads content-image ingestion states via ImageConnection', async () => {
    await getArticleContentImageIngestion(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "i"."ingestion" from "ImageConnection" as "ic" ' +
        'inner join "Image" as "i" on "i"."id" = "ic"."imageId" ' +
        'where "ic"."entityId" = $1 and "ic"."entityType" = $2'
    );
    expect(parameters).toEqual([7, 'Article']);
  });
});

describe('getArticleCoverIngestion', () => {
  it('reads the cover image ingestion state', async () => {
    await getArticleCoverIngestion(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "ingestion" from "Image" where "id" = $1');
    expect(parameters).toEqual([42]);
  });
});

describe('getArticleTextModeration', () => {
  it('reads the EntityModeration verdict for the article', async () => {
    await getArticleTextModeration(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "status", "blocked" from "EntityModeration" ' +
        'where "entityType" = $1 and "entityId" = $2'
    );
    expect(parameters).toEqual(['Article', 7]);
  });
});

describe('setArticleIngestion', () => {
  it('casts the ingestion enum and omits contentScannedAt when not supplied', async () => {
    await setArticleIngestion(harness.db, { id: 7, ingestion: 'Pending' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus" where "id" = $2'
    );
    expect(parameters).toEqual(['Pending', 7]);
  });

  it('sets contentScannedAt when supplied', async () => {
    const contentScannedAt = new Date('2024-01-01T00:00:00.000Z');
    await setArticleIngestion(harness.db, { id: 7, ingestion: 'Scanned', contentScannedAt });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus", "contentScannedAt" = $2 where "id" = $3'
    );
    expect(parameters).toEqual(['Scanned', contentScannedAt, 7]);
  });
});

describe('delete statements', () => {
  it('deleteArticleFiles scopes to the article and Article entityType', async () => {
    await deleteArticleFiles(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('delete from "File" where "entityId" = $1 and "entityType" = $2');
    expect(parameters).toEqual([7, 'Article']);
  });

  it('deleteArticleImageConnections scopes to the article and Article entityType', async () => {
    await deleteArticleImageConnections(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('delete from "ImageConnection" where "entityId" = $1 and "entityType" = $2');
    expect(parameters).toEqual([7, 'Article']);
  });

  it('deleteArticleRecord removes just the article row', async () => {
    await deleteArticleRecord(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('delete from "Article" where "id" = $1');
    expect(parameters).toEqual([7]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import {
  countArticlesForModeration,
  deleteArticleFiles,
  deleteArticleForUser,
  deleteArticleImageConnections,
  deleteArticleReactionForUser,
  deleteArticleRecord,
  getArticleContentImageIngestion,
  getArticleContentImages,
  getArticleCoverIngestion,
  getArticleForRescan,
  getArticleForRestore,
  getArticleForUnpublish,
  getArticleTextModeration,
  getArticlesForModeration,
  lockArticleForIngestion,
  refreshArticleNsfwLevel,
  refreshArticleNsfwLevelMany,
  setArticleIngestion,
  setArticleIngestionState,
  setArticleRescanRequested,
  setArticleRestored,
  setArticleUnpublished,
  updateArticle,
} from './article.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('updateArticle', () => {
  it('sets the given columns, auto-stamps updatedAt, returns all, keyed by id', async () => {
    await updateArticle(harness.db, { id: 7, status: 'Published' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "status" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters).toEqual(['Published', expect.any(Date), 7]);
  });
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

describe('getArticleForUnpublish', () => {
  it('selects the owner/publish-state fields', async () => {
    await getArticleForUnpublish(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "userId", "publishedAt", "status" from "Article" where "id" = $1');
    expect(parameters).toEqual([7]);
  });
});

describe('getArticleForRescan', () => {
  it('selects the fields needed to re-link images and re-moderate text', async () => {
    await getArticleForRescan(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "id", "userId", "content", "title", "coverId" from "Article" where "id" = $1'
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
      'update "Article" set "status" = $1, "publishedAt" = $2, "metadata" = $3::jsonb, ' +
        '"updatedAt" = $4 where "id" = $5'
    );
    expect(parameters[0]).toBe('Published');
    expect(parameters[1]).toBe(publishedAt);
    expect(parameters[2]).toBe('{"a":1}');
    expect(parameters[3]).toBeInstanceOf(Date); // updatedAt, plugin-stamped (restore surfaces the article)
    expect(parameters[4]).toBe(7);
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
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus", ' +
        '"updatedAt" = "updatedAt" where "id" = $2'
    );
    expect(sql).toContain('"updatedAt" = "updatedAt"'); // self-reference: keep current value, no bump
    expect(parameters).toEqual(['Pending', 7]);
  });

  it('sets contentScannedAt when supplied', async () => {
    const contentScannedAt = new Date('2024-01-01T00:00:00.000Z');
    await setArticleIngestion(harness.db, { id: 7, ingestion: 'Scanned', contentScannedAt });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus", "contentScannedAt" = $2, ' +
        '"updatedAt" = "updatedAt" where "id" = $3'
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

describe('setArticleUnpublished', () => {
  it('sets the status, jsonb metadata, and bumps updatedAt', async () => {
    await setArticleUnpublished(harness.db, {
      id: 7,
      status: 'UnpublishedViolation',
      metadata: { unpublishedBy: 99 },
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "status" = $1, "metadata" = $2::jsonb, "updatedAt" = $3 where "id" = $4'
    );
    expect(parameters[0]).toBe('UnpublishedViolation');
    expect(parameters[1]).toBe('{"unpublishedBy":99}');
    expect(parameters[2]).toBeInstanceOf(Date);
    expect(parameters[3]).toBe(7);
  });
});

describe('setArticleRescanRequested', () => {
  it('resets ingestion to Rescan, stamps scanRequestedAt, clears contentScannedAt, keeps updatedAt', async () => {
    await setArticleRescanRequested(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = \'Rescan\'::"ArticleIngestionStatus", ' +
        '"scanRequestedAt" = $1, "contentScannedAt" = $2, "updatedAt" = "updatedAt" where "id" = $3'
    );
    expect(sql).toContain('"updatedAt" = "updatedAt"'); // self-reference: keep current value, no bump
    expect(parameters).toHaveLength(3); // no extra Date param for updatedAt
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters[1]).toBeNull();
    expect(parameters[2]).toBe(7);
  });
});

describe('getArticleContentImages', () => {
  it('reads content-image fields for the rescan re-queue via ImageConnection', async () => {
    await getArticleContentImages(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "i"."id", "i"."url", "i"."ingestion", "i"."type" from "ImageConnection" as "ic" ' +
        'inner join "Image" as "i" on "i"."id" = "ic"."imageId" ' +
        'where "ic"."entityId" = $1 and "ic"."entityType" = $2'
    );
    expect(parameters).toEqual([7, 'Article']);
  });
});

describe('lockArticleForIngestion', () => {
  it('takes a transaction-scoped advisory lock on the article id', async () => {
    await lockArticleForIngestion(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('SELECT pg_advisory_xact_lock($1)');
    expect(parameters).toEqual([7]);
  });
});

describe('setArticleIngestionState', () => {
  it('sets only the ingestion enum when no scanned/publish flags supplied', async () => {
    await setArticleIngestionState(harness.db, { id: 7, ingestion: 'Pending' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus", ' +
        '"updatedAt" = "updatedAt" where "id" = $2'
    );
    expect(sql).toContain('"updatedAt" = "updatedAt"'); // self-reference: keep current value, no bump
    expect(parameters).toEqual(['Pending', 7]);
  });

  it('flips status/publishedAt together and stamps contentScannedAt when reaching Scanned', async () => {
    const contentScannedAt = new Date('2024-01-01T00:00:00.000Z');
    const publishedAt = new Date('2024-02-02T00:00:00.000Z');
    await setArticleIngestionState(harness.db, {
      id: 7,
      ingestion: 'Scanned',
      contentScannedAt,
      publishedAt,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Article" set "ingestion" = $1::"ArticleIngestionStatus", ' +
        '"contentScannedAt" = $2, "status" = $3, "publishedAt" = $4, ' +
        '"updatedAt" = "updatedAt" where "id" = $5'
    );
    expect(parameters).toEqual(['Scanned', contentScannedAt, 'Published', publishedAt, 7]);
  });
});

describe('refreshArticleNsfwLevelMany', () => {
  it('emits the bulk re-derive with an IN list, RETURNING, and ids bound twice', async () => {
    await refreshArticleNsfwLevelMany(harness.db, [7, 8]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('GREATEST');
    expect(sql).toContain(`cover."ingestion" IN ('Scanned', 'Blocked')`);
    expect(sql).toContain('IN ($1, $2)');
    expect(sql).toContain('RETURNING a.id');
    expect(sql).not.toContain('IN ()');
    // ids bound once per CTE (level + moderation_floor)
    expect(parameters).toEqual([7, 8, 7, 8]);
  });

  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await refreshArticleNsfwLevelMany(harness.db, []);
    expect(result).toEqual({ rows: [] });
    expect(harness.queries).toHaveLength(0);
  });
});

describe('per-user content deletes', () => {
  it("deleteArticleForUser deletes the user's articles", async () => {
    await deleteArticleForUser(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "Article" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });

  it("deleteArticleReactionForUser deletes the user's article reactions", async () => {
    await deleteArticleReactionForUser(harness.db, 7);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "ArticleReaction" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ImageService from '~/server/services/image.service';

/**
 * The two removal paths #4661 left open.
 *
 * `CollectionItem` cascades from `Post` and from `Article`, so both deletes take the
 * membership rows with them. #4679 made the index delete documents that stopped
 * matching, but only for ids in a batch — so a collection nothing enqueues keeps its
 * pre-deletion document. #4661 wired the image and permanent-model paths; these two
 * were not.
 */

const { mockCollectionsQueueUpdate, mockQueueImageSearchIndexUpdate, mockArticlesQueueUpdate } =
  vi.hoisted(() => ({
    mockCollectionsQueueUpdate: vi.fn(),
    mockQueueImageSearchIndexUpdate: vi.fn(),
    mockArticlesQueueUpdate: vi.fn(),
  }));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
  invalidateManyImageExistence: vi.fn(),
  deleteImageFromS3: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: mockArticlesQueueUpdate },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

const POST_ID = 5519;
const ARTICLE_ID = 3307;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;
const POST_IMAGE = { id: 6142, url: 'post-image-url', deletable: true };

let issued: string[] = [];

const sqlText = (strings: TemplateStringsArray | string[]) => Array.from(strings).join(' ? ');

beforeEach(() => {
  vi.clearAllMocks();
  issued = [];
});

describe('deletePost', () => {
  function primePost() {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      issued.push(sql);
      if (sql.includes('pg_class')) return [{ present: false }];
      // The only statement selecting collection ids.
      if (sql.includes('"collectionId"')) return [{ collectionId: COLLECTION_A }];
      if (sql.includes('AS deletable')) return [POST_IMAGE];
      if (sql.includes('DELETE FROM "Image"')) return [{ id: POST_IMAGE.id, url: POST_IMAGE.url }];
      if (sql.includes('DELETE FROM "Post"')) return [{ id: POST_ID, nsfwLevel: 0 }];
      // The resolver's own image-id lookup.
      if (sql.includes('FROM "Image" i')) return [{ id: POST_IMAGE.id }];
      return [];
    });
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      typeof fn === 'function' ? fn(dbMock.dbWrite) : undefined
    );
  }

  it('queues a rebuild for the collections the post was showing in', async () => {
    primePost();
    const { deletePost } = await import('~/server/services/post.service');

    await deletePost({ id: POST_ID });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledTimes(1);
    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('queues the rebuild even when a later post-commit step fails', async () => {
    // The rows are already gone by then, and the pre-delete snapshot is the only
    // record of which documents went stale — so a Redis blip in a sibling step must
    // not be able to skip it.
    primePost();
    mockQueueImageSearchIndexUpdate.mockRejectedValueOnce(new Error('redis down'));
    const { deletePost } = await import('~/server/services/post.service');

    await expect(deletePost({ id: POST_ID })).rejects.toThrow();

    expect(mockCollectionsQueueUpdate).toHaveBeenCalled();
  });

  it('resolves the collections before the delete that cascades them away', async () => {
    primePost();
    const { deletePost } = await import('~/server/services/post.service');

    await deletePost({ id: POST_ID });

    const resolveAt = issued.findIndex((s) => s.includes('"collectionId"'));
    const deleteAt = issued.findIndex((s) => s.includes('DELETE FROM "Post"'));
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(deleteAt);
  });
});

describe('deleteArticleById', () => {
  function primeArticle() {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      issued.push(sql);
      if (sql.includes('pg_class')) return [{ present: false }];
      if (sql.includes('"collectionId"'))
        return [{ collectionId: COLLECTION_A }, { collectionId: COLLECTION_B }];
      return [];
    });
    dbMock.dbWrite.article.findUnique.mockResolvedValue({ userId: 42 });
    dbMock.dbWrite.article.delete.mockImplementation(async () => {
      issued.push('ARTICLE_DELETE');
      return { coverId: null };
    });
    dbMock.dbWrite.imageConnection.findMany.mockResolvedValue([]);
    dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      typeof fn === 'function' ? fn(dbMock.dbWrite) : undefined
    );
  }

  it('queues a rebuild for the collections holding the article as an item', async () => {
    primeArticle();
    const { deleteArticleById } = await import('~/server/services/article.service');

    await deleteArticleById({ id: ARTICLE_ID, userId: 42 });

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith([
      { id: COLLECTION_A, action: SearchIndexUpdateQueueAction.Update },
      { id: COLLECTION_B, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('queues the rebuild even when a later post-commit step fails', async () => {
    // Same exposure as deletePost: the article row is already gone, so the pre-delete
    // snapshot is the only record left, and everything after the commit runs inside a
    // try that rethrows via throwDbError.
    primeArticle();
    mockArticlesQueueUpdate.mockRejectedValueOnce(new Error('redis down'));
    const { deleteArticleById } = await import('~/server/services/article.service');

    await expect(deleteArticleById({ id: ARTICLE_ID, userId: 42 })).rejects.toThrow();

    expect(mockCollectionsQueueUpdate).toHaveBeenCalled();
  });

  it('resolves the collections before the delete that cascades them away', async () => {
    primeArticle();
    const { deleteArticleById } = await import('~/server/services/article.service');

    await deleteArticleById({ id: ARTICLE_ID, userId: 42 });

    const resolveAt = issued.findIndex((s) => s.includes('"collectionId"'));
    const deleteAt = issued.indexOf('ARTICLE_DELETE');
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(resolveAt).toBeLessThan(deleteAt);
  });
});

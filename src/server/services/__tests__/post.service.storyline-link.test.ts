import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';

// A post written from the storyline flow is linked to its storyline in the same transaction that
// creates it, so a refused link leaves no draft behind. Module-load scaffold from
// post.service.text-scan.test.ts.

const { linkPendingChapter } = vi.hoisted(() => ({ linkPendingChapter: vi.fn() }));
vi.mock('~/server/services/storyline.service', () => ({ linkPendingChapter }));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntityInBackground: vi.fn(),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {}, pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
  preventReplicationLagBatch: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

// Every cache post.service imports — each a stub whose methods are no-op vi.fns. (Named
// exports must be statically present for ESM import binding; a Proxy has no own keys.)
vi.mock('~/server/redis/caches', () => {
  const cacheStub = () => ({
    refresh: vi.fn().mockResolvedValue(undefined),
    bust: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn(),
    refreshMany: vi.fn(),
  });
  return {
    imageMetaCache: cacheStub(),
    imageResourcesCache: cacheStub(),
    modelVersionAccessCache: cacheStub(),
    postStatCache: cacheStub(),
    thumbnailCache: cacheStub(),
    imageMetadataCache: cacheStub(),
    userBasicCache: cacheStub(),
    userImageVideoCountCaches: cacheStub(),
    userPostCountCache: cacheStub(),
  };
});

// The heavy image.service graph — replaced wholesale with the named exports post.service
// imports. `purgeResizeCache` is spied so we can assert the hide-only path independently.
vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  createImageResources: vi.fn(),
  deleteImageFromS3: vi.fn(),
  deleteImagesForModelVersionCache: vi.fn(),
  getImagesForPosts: vi.fn(),
  imagesForModelVersionsCache: { refresh: vi.fn() },
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
  purgeImageGenerationDataCache: vi.fn(),
  purgeResizeCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));

vi.mock('~/server/services/image-delivery.service', () => ({
  bustImageDeliveryMetadataCache: vi.fn(),
}));

// Other sibling services post.service imports — mocked so their graphs aren't evaluated.
vi.mock('~/server/services/collection.service', () => ({
  getCollectionById: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  removeEntityFromAllCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/post-collection-visibility', () => ({ canViewCollectionPost: vi.fn() }));
vi.mock('~/server/services/tag.service', () => ({
  findOrCreateTagsByName: vi.fn(),
  getVotableImageTags: vi.fn(),
}));
vi.mock('~/server/services/technique.service', () => ({ getTechniqueForWorkflow: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));

const { createPost } = await import('~/server/services/post.service');

const POST_ID = 11;
const USER_ID = 5;
/** The transaction's own client, distinct from dbWrite, so a write made outside it is seen. */
const tx = { post: { create: vi.fn() } };
const w = dbMock.dbWrite;

beforeEach(() => {
  vi.clearAllMocks();
  w.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
  const created = { id: POST_ID, userId: USER_ID, publishedAt: null, collectionId: null, tags: [] };
  tx.post.create.mockResolvedValue(created);
  w.post.create.mockResolvedValue(created as never);
});

describe('createPost from the storyline flow', () => {
  it('writes the post and its storyline link in one transaction', async () => {
    await createPost({ userId: USER_ID, storylineId: 7 } as never);
    expect(w.post.create).not.toHaveBeenCalled();
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    // The link fields are the link's, not columns of the post.
    expect(tx.post.create.mock.calls[0][0].data).not.toHaveProperty('storylineId');
    expect(tx.post.create.mock.calls[0][0].data).not.toHaveProperty('parentChapterId');
    expect(linkPendingChapter).toHaveBeenCalledWith(tx, {
      postId: POST_ID,
      userId: USER_ID,
      storylineId: 7,
      parentChapterId: undefined,
    });
  });

  it('passes a continuation through as the chapter it continues', async () => {
    await createPost({ userId: USER_ID, parentChapterId: 40 } as never);
    expect(linkPendingChapter).toHaveBeenCalledWith(tx, {
      postId: POST_ID,
      userId: USER_ID,
      storylineId: undefined,
      parentChapterId: 40,
    });
  });

  it('fails the whole create when the link is refused', async () => {
    linkPendingChapter.mockRejectedValueOnce(new Error('Continuations are not available'));
    await expect(createPost({ userId: USER_ID, parentChapterId: 40 } as never)).rejects.toThrow(
      'Continuations are not available'
    );
    // The post row went through the transaction's client, so the refusal rolls it back.
    expect(tx.post.create).toHaveBeenCalledTimes(1);
    expect(w.post.create).not.toHaveBeenCalled();
  });

  it('refuses a post created already published, before writing anything', async () => {
    await expect(
      createPost({ userId: USER_ID, storylineId: 7, publishedAt: new Date() } as never)
    ).rejects.toThrow('A storyline chapter is published from the post editor');
    expect(tx.post.create).not.toHaveBeenCalled();
    expect(w.post.create).not.toHaveBeenCalled();
    expect(linkPendingChapter).not.toHaveBeenCalled();
  });

  it('leaves an ordinary post outside any transaction and unlinked', async () => {
    await createPost({ userId: USER_ID, title: 'Hello' } as never);
    expect(w.post.create).toHaveBeenCalledTimes(1);
    expect(w.$transaction).not.toHaveBeenCalled();
    expect(linkPendingChapter).not.toHaveBeenCalled();
  });
});

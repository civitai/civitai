import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';

// A post is scanned once it has a publish date (scheduled included), and again when its text
// changes after that; a draft is never scanned. Module-load scaffold from
// update-post-image-hidemeta-bust.test.ts.

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

const { createPost, updatePost } = await import('~/server/services/post.service');
const { scanEntityInBackground } = await import('~/server/services/text-scan/submit');

const POST_ID = 11;
const USER = { id: 5, isModerator: false } as never;
const tx = { post: { update: vi.fn() }, $queryRaw: vi.fn() };

const scanned = () => vi.mocked(scanEntityInBackground).mock.calls.length > 0;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx));
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
});

describe('createPost text scan', () => {
  const create = (publishedAt: Date | null) => {
    dbMock.dbWrite.post.create.mockResolvedValue({
      id: POST_ID,
      userId: 5,
      publishedAt,
      collectionId: null,
      tags: [],
    } as never);
    return createPost({ userId: 5, title: 'Hello', detail: 'there' } as never);
  };

  it('does not scan a draft created with text', async () => {
    await create(null);
    expect(scanned()).toBe(false);
  });

  it('scans a post created already dated', async () => {
    await create(new Date());
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Post', entityId: POST_ID });
  });
});

describe('updatePost text scan', () => {
  const update = (
    stored: Date | null,
    data: Record<string, unknown>,
    written: { publishedAt: Date }[] = []
  ) => {
    tx.post.update.mockResolvedValue({ id: POST_ID, userId: 5, publishedAt: stored });
    tx.$queryRaw.mockResolvedValue(written);
    return updatePost({ id: POST_ID, user: USER, ...data } as never);
  };

  it('does not scan a text edit on a draft', async () => {
    await update(null, { title: 'New title' });
    expect(scanned()).toBe(false);
  });

  it('scans a text edit on a published post', async () => {
    await update(new Date('2020-01-01'), { detail: 'New detail' });
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Post', entityId: POST_ID });
  });

  it('scans a write that dates the post, with its text unchanged', async () => {
    const publishedAt = new Date();
    await update(null, { publishedAt }, [{ publishedAt }]);
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Post', entityId: POST_ID });
  });

  it('does not scan a non-text edit on a published post', async () => {
    await update(new Date('2020-01-01'), { collectionId: 3 });
    expect(scanned()).toBe(false);
  });
});

describe('updatePost title and detail writes', () => {
  const update = (data: Record<string, unknown>) => {
    tx.post.update.mockResolvedValue({ id: POST_ID, userId: 5, publishedAt: null });
    return updatePost({ id: POST_ID, user: USER, ...data } as never);
  };
  const written = () => tx.post.update.mock.calls[0][0].data;

  it('clearing the title writes null', async () => {
    await update({ title: '' });
    expect(written().title).toBeNull();
  });

  it('clearing the detail writes null', async () => {
    await update({ detail: '' });
    expect(written().detail).toBeNull();
  });

  it('a non-empty title and detail are written as sent', async () => {
    await update({ title: 'Title', detail: '<p>Detail</p>' });
    expect(written()).toMatchObject({ title: 'Title', detail: '<p>Detail</p>' });
  });

  it('an omitted title and detail are left untouched', async () => {
    await update({ collectionId: 3 });
    expect(written().title).toBeUndefined();
    expect(written().detail).toBeUndefined();
  });
});

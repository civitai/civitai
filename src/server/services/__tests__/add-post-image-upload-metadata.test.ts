import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Metadata from '~/utils/metadata';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * `addPostImage` reads an upload's embedded metadata from storage when the caller sent none.
 *
 * The post.service import scaffold mirrors update-post-image-hidemeta-bust.test.ts.
 */

const KEY = '6f1c2b9e-3a4d-4e5f-8a7b-9c0d1e2f3a4b';
const UPLOAD_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const mocks = vi.hoisted(() => ({
  readImageUploadObjectHead: vi.fn(),
  getMetadata: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  readImageUploadObjectHead: mocks.readImageUploadObjectHead,
}));
vi.mock('~/utils/metadata', async (importOriginal) => ({
  ...(await importOriginal<typeof Metadata>()),
  getMetadata: mocks.getMetadata,
}));

// --- infra scaffold (mirrors contest-entry-resource-gate.test.ts) ---------------------
// `~/server/redis/client` is covered by the canonical mock registered in src/__tests__/setup.ts,
// which supplies redis/sysRedis plus the REAL key tables. The local stub this replaces returned a
// self-vivifying proxy for every REDIS_*_KEYS lookup, so any key the code composed came back as the
// same placeholder — nothing here asserts a key, so the swap changes no assertion.
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

// The heavy image.service graph — replaced wholesale with the named exports post.service imports.
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

const { addPostImage } = await import('~/server/services/post.service');

const user = { id: 5 } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.readImageUploadObjectHead.mockResolvedValue(UPLOAD_BYTES);
  mocks.getMetadata.mockResolvedValue({ prompt: 'a lighthouse' });
  // Stop right after metadata extraction: the post lookup misses and addPostImage throws.
  dbMock.dbRead.post.findFirst.mockResolvedValue(null);
});

describe('addPostImage — metadata of an upload sent without meta', () => {
  it('parses the bytes read from the upload store, never a CDN url', async () => {
    await expect(
      addPostImage({ url: KEY, type: 'image', postId: 1, user } as never)
    ).rejects.toThrow();

    expect(mocks.readImageUploadObjectHead).toHaveBeenCalledWith(KEY, {
      maxBytes: 8 * 1024 * 1024,
    });
    expect(mocks.getMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.getMetadata).toHaveBeenCalledWith(UPLOAD_BYTES);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('does not read the upload when the caller supplied meta', async () => {
    await expect(
      addPostImage({ url: KEY, type: 'image', postId: 1, user, meta: { prompt: 'x' } } as never)
    ).rejects.toThrow();

    expect(mocks.readImageUploadObjectHead).not.toHaveBeenCalled();
    expect(mocks.getMetadata).not.toHaveBeenCalled();
  });

  it('creates the image as a client url', async () => {
    dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: 5, collection: null } as never);
    dbMock.dbRead.image.findFirst.mockResolvedValue(null);
    const { createImage } = await import('~/server/services/image.service');

    await addPostImage({ url: KEY, type: 'image', postId: 1, user } as never).catch(() => null);

    expect(vi.mocked(createImage)).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: KEY, userId: 5, clientUrl: true })
    );
  });

  it('creates a server-minted url without the client url flag', async () => {
    dbMock.dbRead.post.findFirst.mockResolvedValue({ userId: 5, collection: null } as never);
    dbMock.dbRead.image.findFirst.mockResolvedValue(null);
    const { createImage } = await import('~/server/services/image.service');

    await addPostImage({
      url: KEY,
      type: 'image',
      postId: 1,
      user,
      serverMintedUrl: true,
    } as never).catch(() => null);

    expect(vi.mocked(createImage)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(createImage).mock.calls[0][0] as Record<string, unknown>;
    expect(args.clientUrl).toBeUndefined();
    expect(args).not.toHaveProperty('serverMintedUrl');
  });

  it('still proceeds when the upload cannot be read', async () => {
    mocks.readImageUploadObjectHead.mockRejectedValue(new Error('NoSuchKey'));

    await expect(
      addPostImage({ url: KEY, type: 'image', postId: 1, user } as never)
    ).rejects.toThrow(/^No post with id 1$/);
    expect(mocks.readImageUploadObjectHead).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.post.findFirst).toHaveBeenCalledTimes(1);
  });
});

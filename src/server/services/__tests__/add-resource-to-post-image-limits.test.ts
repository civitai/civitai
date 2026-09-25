import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  MAX_MANUAL_CHECKPOINTS_PER_IMAGE,
  MAX_MANUAL_RESOURCES_PER_IMAGE,
} from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { manualResourceLimitMessages } from '~/utils/manual-image-resources';

/**
 * Server enforcement of the manual image resource limits in `addResourceToPostImage`, the only
 * route that credits an arbitrary number of resources to an image by hand. The editor enforces
 * the same limits, but this is the boundary API and OAuth clients reach.
 *
 * The module scaffold mirrors update-post-image-hidemeta-bust.test.ts.
 */

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
vi.mock('~/server/services/technique.service', () => ({ getTechniqueByName: vi.fn() }));
vi.mock('~/server/services/tool.service', () => ({
  getToolByAlias: vi.fn(),
  getToolByDomain: vi.fn(),
  getToolByName: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));

const { addResourceToPostImage } = await import('~/server/services/post.service');

const IMAGE_ID = 101;
const NEW_VERSION_ID = 9_000_000;
const user = { id: 1 } as Parameters<typeof addResourceToPostImage>[0]['user'];

const mockVersionFindFirst = dbMock.dbRead.modelVersion.findFirst;
const mockImageFindMany = dbMock.dbWrite.image.findMany;
const mockLockQuery = dbMock.dbWrite.$queryRaw;
const mockHelperFindMany = dbMock.dbWrite.imageResourceHelper.findMany;
const mockCreate = dbMock.dbWrite.imageResourceNew.createManyAndReturn;

let nextVersionId = 1;
const rows = (n: number, modelType: ModelType, detected: boolean) =>
  Array.from({ length: n }, () => ({
    imageId: IMAGE_ID,
    modelVersionId: nextVersionId++,
    modelType,
    detected,
  }));

function arrange({ adding, existing }: { adding: ModelType; existing: ReturnType<typeof rows> }) {
  mockVersionFindFirst.mockResolvedValue({
    name: 'v1',
    model: { id: 1, name: 'm', type: adding },
    files: [],
  });
  mockImageFindMany.mockResolvedValue([{ postId: null, meta: null, type: 'image' }]);
  mockHelperFindMany.mockResolvedValue(existing);
  mockCreate.mockResolvedValue([{ imageId: IMAGE_ID, modelVersionId: NEW_VERSION_ID }]);
}

const add = () => addResourceToPostImage({ id: [IMAGE_ID], modelVersionId: NEW_VERSION_ID, user });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('addResourceToPostImage manual resource limits', () => {
  it('refuses a manual resource past the total limit, and writes nothing', async () => {
    arrange({
      adding: ModelType.LORA,
      existing: rows(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, false),
    });
    await expect(add()).rejects.toThrow(manualResourceLimitMessages.total);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses a checkpoint past the checkpoint limit, and writes nothing', async () => {
    arrange({
      adding: ModelType.Checkpoint,
      existing: rows(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, false),
    });
    await expect(add()).rejects.toThrow(manualResourceLimitMessages.checkpoints);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not count auto-detected resources toward either limit', async () => {
    arrange({
      adding: ModelType.Checkpoint,
      existing: [
        ...rows(MAX_MANUAL_RESOURCES_PER_IMAGE, ModelType.LORA, true),
        ...rows(MAX_MANUAL_CHECKPOINTS_PER_IMAGE, ModelType.Checkpoint, true),
      ],
    });
    await expect(add()).resolves.toBeDefined();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data).toEqual([
      { imageId: IMAGE_ID, modelVersionId: NEW_VERSION_ID, detected: false },
    ]);
  });

  it('locks the image rows before reading the resources it checks, and writes after', async () => {
    arrange({ adding: ModelType.LORA, existing: [] });
    await add();

    const lockCall = mockLockQuery.mock.calls.find(([strings]: [TemplateStringsArray]) =>
      strings.join('?').includes('FOR UPDATE')
    );
    expect(lockCall, 'no FOR UPDATE query was issued').toBeDefined();
    const lockOrder =
      mockLockQuery.mock.invocationCallOrder[mockLockQuery.mock.calls.indexOf(lockCall)];
    expect(lockOrder).toBeLessThan(mockHelperFindMany.mock.invocationCallOrder[0]);
    expect(mockHelperFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreate.mock.invocationCallOrder[0]
    );
  });
});

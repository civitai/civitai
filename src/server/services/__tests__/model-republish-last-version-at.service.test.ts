import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Model.lastVersionAt follows the newest published version, and an unpublish/republish cycle can't
// be used to move a model up the Newest feed: a republish only restores a date some version already
// had, and never lowers the stored value (which would undo a moderator bump).

const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    model: { update: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
    modelVersion: { findFirst: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
  preventModelVersionLagBatch: vi.fn(),
}));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {}, pgDbReadLong: {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null, Tracker: class {} }));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(() => false), FLIPT_FEATURE_FLAGS: {} }));
vi.mock('~/server/metrics', () => ({ modelMetrics: {} }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: {},
  modelTagCache: { refresh: vi.fn() },
  modelVotableTagsCache: { bust: vi.fn() },
  userBasicCache: {},
  userModelCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: vi.fn(),
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/collection.service', () => ({
  getAvailableCollectionItemsFilterForUser: vi.fn(),
  getUserCollectionPermissionsById: vi.fn(),
  saveItemInCollections: vi.fn(),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn(),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getUnavailableResources: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: {},
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/subscriptions.service', () => ({ getHighestTierSubscription: vi.fn() }));
vi.mock('~/server/services/system-cache', () => ({ getCategoryTags: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn(),
  getProfilePicturesForUsers: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  bustFetchThroughCache: vi.fn(),
  fetchThroughCache: vi.fn(),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObjects: vi.fn() }));
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocationsBatch: vi.fn() }));

import { userModelCountCache } from '~/server/redis/caches';
import {
  publishModelById,
  unpublishModelById,
  updateModelLastVersionAt,
} from '~/server/services/model.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const ORIGINAL_PUBLISHED_AT = new Date('2026-09-27T22:29:33.511Z');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx)
  );
  mockTx.model.update.mockResolvedValue({
    id: MODEL_ID,
    userId: OWNER_ID,
    nsfw: false,
    modelVersions: [{ id: VERSION_ID, baseModel: 'Illustrious' }],
    status: 'Published',
  });
  mockTx.model.updateMany.mockResolvedValue({ count: 0 });
  mockTx.model.findUniqueOrThrow.mockResolvedValue({ status: 'Published', userId: OWNER_ID });
  mockTx.modelVersion.findFirst.mockResolvedValue({ publishedAt: ORIGINAL_PUBLISHED_AT });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockTx.$executeRaw.mockResolvedValue(0);
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

const fullWrites = () =>
  mockTx.model.update.mock.calls
    .map(([args]) => args.data?.lastVersionAt)
    .filter((value) => value !== undefined);

describe('updateModelLastVersionAt', () => {
  it('takes the newest past publishedAt among versions that are still published', async () => {
    await updateModelLastVersionAt({ id: MODEL_ID, tx: mockTx as never });

    const [args] = mockTx.modelVersion.findFirst.mock.calls[0];
    expect(args.where).toMatchObject({
      modelId: MODEL_ID,
      status: 'Published',
      publishedAt: { not: null, lte: expect.any(Date) },
    });
    expect(args.orderBy).toEqual({ publishedAt: 'desc' });
    expect(fullWrites()).toEqual([ORIGINAL_PUBLISHED_AT]);
  });

  it('with onlyForward, writes only when the stored value is older or missing', async () => {
    await updateModelLastVersionAt({ id: MODEL_ID, tx: mockTx as never, onlyForward: true });

    expect(mockTx.model.updateMany).toHaveBeenCalledWith({
      where: {
        id: MODEL_ID,
        OR: [{ lastVersionAt: null }, { lastVersionAt: { lt: ORIGINAL_PUBLISHED_AT } }],
      },
      data: { lastVersionAt: ORIGINAL_PUBLISHED_AT },
    });
    expect(fullWrites()).toEqual([]);
    expect(userModelCountCache.refresh).not.toHaveBeenCalled();
  });

  it('with onlyForward, refreshes the owner cache when it did move the value', async () => {
    mockTx.model.updateMany.mockResolvedValue({ count: 1 });

    await updateModelLastVersionAt({ id: MODEL_ID, tx: mockTx as never, onlyForward: true });

    expect(userModelCountCache.refresh).toHaveBeenCalledWith(OWNER_ID);
  });
});

describe('Model.lastVersionAt across a whole-model publish lifecycle', () => {
  it('fully recomputes on a first publish', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [VERSION_ID], republishing: false });

    expect(fullWrites()).toEqual([ORIGINAL_PUBLISHED_AT]);
    expect(mockTx.model.updateMany).not.toHaveBeenCalled();
  });

  it('leaves it alone when the model is unpublished', async () => {
    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(mockTx.model.update).toHaveBeenCalled();
    expect(fullWrites()).toEqual([]);
    expect(mockTx.model.updateMany).not.toHaveBeenCalled();
  });

  it('only moves it forward when the model is republished with all its versions', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [VERSION_ID], republishing: true });

    expect(fullWrites()).toEqual([]);
    expect(mockTx.model.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ lastVersionAt: null }, { lastVersionAt: { lt: ORIGINAL_PUBLISHED_AT } }],
        }),
      })
    );
  });
});

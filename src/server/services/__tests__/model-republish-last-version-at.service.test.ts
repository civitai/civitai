import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Unpublishing and republishing a whole model must not move Model.lastVersionAt — otherwise the
// cycle is a way to push a model back to the top of the Newest feed, or to knock a bumped one down.

const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    model: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
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

import { publishModelById, unpublishModelById } from '~/server/services/model.service';

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
  mockTx.model.findUniqueOrThrow.mockResolvedValue({ status: 'Published' });
  mockTx.modelVersion.findFirst.mockResolvedValue({ publishedAt: ORIGINAL_PUBLISHED_AT });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  mockTx.$executeRaw.mockResolvedValue(0);
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
});

const lastVersionAtWrites = () =>
  mockTx.model.update.mock.calls
    .map(([args]) => args.data?.lastVersionAt)
    .filter((value) => value !== undefined);

describe('Model.lastVersionAt across a whole-model publish lifecycle', () => {
  it('recomputes on a first publish', async () => {
    await publishModelById({ id: MODEL_ID, versionIds: [VERSION_ID], republishing: false });

    expect(lastVersionAtWrites()).toEqual([ORIGINAL_PUBLISHED_AT]);
  });

  it('leaves it alone when the model is unpublished', async () => {
    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(mockTx.model.update).toHaveBeenCalled();
    expect(lastVersionAtWrites()).toEqual([]);
  });

  it('leaves it alone when the model is republished with all its versions', async () => {
    await publishModelById({
      id: MODEL_ID,
      versionIds: [VERSION_ID],
      meta: { unpublishedBy: OWNER_ID } as never,
      republishing: true,
    });

    expect(mockTx.model.update).toHaveBeenCalled();
    expect(lastVersionAtWrites()).toEqual([]);
  });
});

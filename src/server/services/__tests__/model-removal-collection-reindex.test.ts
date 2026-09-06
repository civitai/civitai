import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression coverage: removing a model must rebuild every collection that contained
 * it.
 *
 * `collections_v3` denormalizes an image for each of a collection's first items, and
 * `prepareBatches` in collections.search-index.ts filters on
 * `c."createdAt" >= lastUpdatedAt` — so the incremental sweep only ever revisits NEWLY
 * CREATED collections. An existing collection is rebuilt only when something enqueues
 * it explicitly, and none of the three model removal paths did: soft delete, permanent
 * delete and unpublish each queued the MODEL index (and the image index) while leaving
 * the collections holding that model pointing at a thumbnail that no longer resolves.
 *
 * These assert the real resolve→enqueue chain, not a spy on a wrapper: the collections
 * index client is the only thing mocked, so a payload assertion here pins the ids and
 * the action that actually reach it.
 *
 * Fixture discipline: the model id, the collection ids and the version/post/image ids
 * are pairwise distinct and distinct from one another's magnitudes, so an id read from
 * the wrong variable cannot satisfy an assertion by coincidence.
 */

const {
  mockCollectionsQueueUpdate,
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockDeleteBidsForModel,
} = vi.hoisted(() => ({
  mockCollectionsQueueUpdate: vi.fn(),
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockDeleteBidsForModel: vi.fn(),
}));

vi.mock('~/server/db/db-lag-helpers', () => ({
  preventReplicationLag: vi.fn(),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
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
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: mockCollectionsQueueUpdate },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: mockDeleteBidsForModel,
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
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
  queueImageSearchIndexUpdate: mockQueueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: {} }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
  createModelVersionPostFromTraining: vi.fn(),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
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

import {
  deleteModelById,
  permaDeleteModelById,
  unpublishModelById,
} from '~/server/services/model.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const MODEL_ID = 4212;
const OWNER_ID = 3307;
const VERSION_ID = 5150;
const COLLECTION_A = 8801;
const COLLECTION_B = 9107;

/**
 * The only `$queryRaw` these paths issue against `CollectionItem` is the collections
 * resolver's. Branching on the SQL rather than on call order means the assertion does
 * not silently start reading someone else's query if one is added later.
 */
function primeCollectionLookup(collectionIds: number[]) {
  mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = Array.from(strings).join('?');
    if (sql.includes('"CollectionItem"'))
      return collectionIds.map((collectionId) => ({ collectionId }));
    return [];
  });
}

const expectedUpdatePayload = (ids: number[]) =>
  ids.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }));

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === 'function' ? arg(mockDbWrite) : Promise.all(arg)
  );
  primeCollectionLookup([COLLECTION_A, COLLECTION_B]);
});

describe('deleteModelById — soft delete', () => {
  beforeEach(() => {
    mockDbWrite.model.update.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
  });

  it('queues an Update for every collection that contained the model', async () => {
    await deleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_A, COLLECTION_B])
    );
  });

  it('resolves those collections by the deleted model id', async () => {
    await deleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    const call = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      strings.join('?').includes('"CollectionItem"')
    );
    expect(call).toBeDefined();
    expect((call as unknown[])[0].join('?')).toContain('"modelId"');
    // The id list is bound through `Prisma.join`, which arrives as a Prisma.Sql
    // fragment carrying its own values — flatten one level to reach the id itself.
    const boundValues = (call as unknown[])
      .slice(1)
      .flatMap((v) => (v && typeof v === 'object' && 'values' in v ? (v as any).values : [v]));
    expect(boundValues).toContain(MODEL_ID);
  });

  it('still runs the trailing bid cleanup when the collections enqueue fails', async () => {
    mockCollectionsQueueUpdate.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(deleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any)).resolves.toBeTruthy();
    expect(mockDeleteBidsForModel).toHaveBeenCalledWith({ modelId: MODEL_ID });
  });
});

describe('permaDeleteModelById — permanent delete', () => {
  beforeEach(() => {
    mockDbWrite.modelFile.findMany.mockResolvedValue([]);
    mockDbWrite.model.findUnique.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
    mockDbWrite.post.findMany.mockResolvedValue([{ id: 7012 }]);
    mockDbWrite.image.findMany.mockResolvedValue([{ id: 6631 }]);
    mockDbWrite.model.delete.mockResolvedValue({ id: MODEL_ID, userId: OWNER_ID });
  });

  it('queues an Update for every collection that contained the model or its images', async () => {
    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_A, COLLECTION_B])
    );
  });

  it('resolves the collections BEFORE the delete, since CollectionItem cascades away', async () => {
    const order: string[] = [];
    mockDbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('?');
      if (sql.includes('"CollectionItem"')) {
        order.push('resolve');
        return [{ collectionId: COLLECTION_A }];
      }
      return [];
    });
    mockDbWrite.model.delete.mockImplementation(async () => {
      order.push('delete');
      return { id: MODEL_ID, userId: OWNER_ID };
    });

    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(order).toEqual(['resolve', 'delete']);
  });

  // model.service hard-deletes the model's Posts in the same transaction, and
  // CollectionItem.postId is onDelete: Cascade while the index denormalizes a post
  // item's first image — so Post-type membership rows go stale too and must be
  // resolved before the cascade removes them.
  it('resolves the posts the cascade deletes, not only the model and its images', async () => {
    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    const call = mockDbWrite.$queryRaw.mock.calls.find(([strings]: [string[]]) =>
      strings.join('?').includes('"CollectionItem"')
    );
    expect((call as unknown[])[0].join('?')).toContain('ci."postId"');
  });

  it('still deletes the model when the collections lookup fails', async () => {
    mockDbWrite.$queryRaw.mockRejectedValue(new Error('connection reset'));

    await permaDeleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockDbWrite.model.delete).toHaveBeenCalled();
    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
  });
});

describe('unpublishModelById', () => {
  beforeEach(() => {
    mockDbWrite.model.findUniqueOrThrow.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Published',
      meta: {},
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
    mockDbWrite.model.update.mockResolvedValue({
      id: MODEL_ID,
      userId: OWNER_ID,
      status: 'Unpublished',
      meta: {},
      nsfwLevel: 1,
      modelVersions: [{ id: VERSION_ID }],
    });
    mockDbWrite.post.findMany.mockResolvedValue([{ id: 7012 }]);
    mockDbWrite.image.findMany.mockResolvedValue([{ id: 6631 }]);
  });

  it('queues an Update for every collection that contained the unpublished model', async () => {
    await unpublishModelById({
      id: MODEL_ID,
      userId: OWNER_ID,
      isModerator: true,
    } as any);

    expect(mockCollectionsQueueUpdate).toHaveBeenCalledWith(
      expectedUpdatePayload([COLLECTION_A, COLLECTION_B])
    );
  });
});

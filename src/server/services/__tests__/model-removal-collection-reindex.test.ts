import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Coverage for the two model removal paths, which want OPPOSITE things.
 *
 * `collections_v3` denormalizes an image for each of a collection's first items, and
 * `prepareBatches` in collections.search-index.ts filters on
 * `c."createdAt" >= lastUpdatedAt` — so the incremental sweep only ever revisits NEWLY
 * CREATED collections. An existing collection is rebuilt only when something enqueues
 * it explicitly.
 *
 *   permaDeleteModelById  MUST enqueue. The rows genuinely go away, so the document
 *                         would otherwise keep a thumbnail that no longer resolves.
 *                         These tests assert the real resolve→enqueue chain: the
 *                         collections index client is the only thing mocked, so the
 *                         payload assertions pin the ids and the action that actually
 *                         reach it, and the ordering assertions pin that the resolve
 *                         happens before the cascade removes what it reads.
 *
 *   deleteModelById       MUST NOT enqueue. A soft delete leaves every row intact and
 *                         the index CTEs filter only on ingestion/needsReview, so a
 *                         rebuild re-emits the same image — the enqueue was a provable
 *                         no-op costing up to 10,000 queue writes per delete. The test
 *                         below pins its absence; see the comment there for what would
 *                         have to change for it to be worth re-adding.
 *
 * `unpublishModelById` was in an earlier revision of this file for the same reason as
 * the soft delete, and is not exercised here at all now that it has no enqueue.
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

import { deleteModelById, permaDeleteModelById } from '~/server/services/model.service';
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

  // 🔴 DELIBERATELY NO ENQUEUE. An earlier revision queued a collections rebuild here.
  // It was provably a no-op: the index's image CTEs filter only on
  // `i."ingestion" = 'Scanned' AND i."needsReview" IS NULL` — no `Model.status`, no
  // `Model.deletedAt` — and a soft delete leaves the Model, Post and Image rows intact,
  // so the rebuild re-emits the same image. The cost was up to 10,000 Meilisearch
  // enqueues per soft delete for no change in output. When the image is genuinely
  // removed, deleteImageById/deleteImages enqueue it themselves.
  //
  // If the product answer is "hide a soft-deleted model's images from collection
  // cards", the CTE predicate and this enqueue are needed TOGETHER — neither alone
  // does anything. Re-adding the enqueue by itself will not fix that, which is what
  // this guard is here to say.
  it('does not queue a collections rebuild, which would be a no-op', async () => {
    await deleteModelById({ id: MODEL_ID, userId: OWNER_ID } as any);

    expect(mockCollectionsQueueUpdate).not.toHaveBeenCalled();
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

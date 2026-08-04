import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for getModelEarlyAccessRefundRequirement and the refundEarlyAccess gate in
// unpublishModelById. model.service.ts has a very large import graph, so most of its transitive
// service/db/search dependencies are stubbed out below to keep this a real unit test rather than
// an integration test. Mirrors the mock scaffold used in set-model-minor.service.test.ts.

const { mockDbRead, mockDbWrite, mockTx } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  });
  const tx = { model: mk(), $executeRaw: vi.fn() };
  return {
    mockTx: tx,
    mockDbRead: { model: mk(), modelVersion: mk(), $queryRaw: vi.fn() },
    mockDbWrite: {
      model: mk(),
      modelVersion: mk(),
      paidAccess: mk(),
      entityAccess: mk(),
      post: mk(),
      image: mk(),
      $queryRaw: vi.fn(),
      $executeRaw: vi.fn(),
      $transaction: vi.fn((fn: (tx: typeof tx) => unknown) => fn(tx)),
    },
  };
});

const {
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockLogToAxiom,
  mockDeleteBidsForModel,
  mockGetMultiAccountTransactionsByPrefix,
  mockGetUserBuzzAccountByAccountTypes,
  mockRefundMultiAccountTransaction,
} = vi.hoisted(() => ({
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockDeleteBidsForModel: vi.fn(),
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
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
vi.mock('~/server/redis/client', () => ({
  redis: { del: vi.fn() },
  REDIS_KEYS: { MODEL: { GALLERY_SETTINGS: 'model:gallery-settings' } },
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: mockModelsQueueUpdate },
}));
vi.mock('~/server/services/auction.service', () => ({
  deleteBidsForModel: mockDeleteBidsForModel,
  getLastAuctionReset: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getMultiAccountTransactionsByPrefix: mockGetMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes: mockGetUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn(),
}));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
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
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
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
  getModelEarlyAccessRefundRequirement,
  unpublishModelById,
} from '~/server/services/model.service';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const OTHER_VERSION_ID = 101;
const BUYER_ID = 555;
const OTHER_BUYER_ID = 556;

const HOUR = 60 * 60 * 1000;
const future = () => new Date(Date.now() + HOUR);
const past = () => new Date(Date.now() - HOUR);

type VersionRow = { id: number; meta: Record<string, unknown> | null };
type GateRow = { entityId: number; endsAt: Date | null };
type AccessRow = { accessToId: number; accessorId: number; meta: Record<string, unknown> | null };

function setupRefundData({
  versions = [{ id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } }] as VersionRow[],
  gates = [{ entityId: VERSION_ID, endsAt: null }] as GateRow[],
  accessRows = [
    {
      accessToId: VERSION_ID,
      accessorId: BUYER_ID,
      meta: { 'download-buzzTransactionId': 'tx-1' },
    },
  ] as AccessRow[],
  amounts = { 'tx-1': 300 } as Record<string, number>,
} = {}) {
  mockDbWrite.modelVersion.findMany.mockResolvedValue(versions);
  mockDbWrite.paidAccess.findMany.mockResolvedValue(gates);
  mockDbWrite.entityAccess.findMany.mockResolvedValue(accessRows);
  mockGetMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) => [
    { amount: amounts[prefix] ?? 0 },
  ]);
}

function setupUnpublishWrites() {
  mockTx.model.update.mockResolvedValue({
    userId: OWNER_ID,
    modelVersions: [{ id: VERSION_ID }],
  });
  mockDbWrite.model.findUniqueOrThrow.mockResolvedValue({ name: 'Test Model', userId: OWNER_ID });
  mockDbWrite.post.findMany.mockResolvedValue([]);
  mockDbWrite.image.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
});

describe('getModelEarlyAccessRefundRequirement', () => {
  it('returns nothing and skips the gate lookup when no version was ever purchased', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      { id: VERSION_ID, meta: null },
      { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: false } },
    ]);

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result).toEqual({ purchases: [], buyerCount: 0, totalBuzz: 0 });
    expect(mockDbWrite.paidAccess.findMany).not.toHaveBeenCalled();
  });

  it('ignores versions whose early access window has already lapsed', async () => {
    setupRefundData({ gates: [{ entityId: VERSION_ID, endsAt: past() }] });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result).toEqual({ purchases: [], buyerCount: 0, totalBuzz: 0 });
    expect(mockDbWrite.entityAccess.findMany).not.toHaveBeenCalled();
  });

  it('only looks at grants on versions whose gate is still active', async () => {
    setupRefundData({
      versions: [
        { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
        { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
      ],
      gates: [
        { entityId: VERSION_ID, endsAt: future() },
        { entityId: OTHER_VERSION_ID, endsAt: past() },
      ],
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(mockDbWrite.entityAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accessToId: { in: [VERSION_ID] } }),
      })
    );
    expect(result.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] },
    ]);
  });

  it('skips grants with no purchase transaction and sums both download and generation purchases', async () => {
    setupRefundData({
      versions: [
        { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
        { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
      ],
      gates: [
        { entityId: VERSION_ID, endsAt: null },
        { entityId: OTHER_VERSION_ID, endsAt: future() },
      ],
      accessRows: [
        // Owner-granted access: nothing was paid, so nothing to refund.
        { accessToId: VERSION_ID, accessorId: 999, meta: null },
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: {
            'download-buzzTransactionId': 'tx-1',
            'generation-buzzTransactionId': 'tx-2',
          },
        },
        // Same buyer on a second version — one buyer, two purchases.
        {
          accessToId: OTHER_VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-3' },
        },
        {
          accessToId: OTHER_VERSION_ID,
          accessorId: OTHER_BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-4' },
        },
      ],
      amounts: { 'tx-1': 100, 'tx-2': 200, 'tx-3': 50, 'tx-4': 25 },
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1', 'tx-2'] },
      { modelVersionId: OTHER_VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-3'] },
      { modelVersionId: OTHER_VERSION_ID, buyerId: OTHER_BUYER_ID, buzzTransactionIds: ['tx-4'] },
    ]);
    expect(result.buyerCount).toBe(2);
    expect(result.totalBuzz).toBe(375);
  });
});

describe('unpublishModelById — early access refund gate', () => {
  it('refuses the unpublish when the owner has not consented to refunding', async () => {
    setupRefundData();
    setupUnpublishWrites();

    await expect(unpublishModelById({ id: MODEL_ID, userId: OWNER_ID })).rejects.toThrowError(
      /1 member\(s\) must be refunded a total of 300 Buzz/
    );
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refunds every purchase, revokes the grants, then unpublishes when the owner consents', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: {
            'download-buzzTransactionId': 'tx-1',
            'generation-buzzTransactionId': 'tx-2',
          },
        },
      ],
      amounts: { 'tx-1': 300, 'tx-2': 200 },
    });
    setupUnpublishWrites();
    mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 1000 });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, refundEarlyAccess: true });

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'tx-1' })
    );
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'tx-2' })
    );
    // deleteMany, not delete: an already-revoked grant must not abort a retry after the money moved.
    expect(mockDbWrite.entityAccess.deleteMany).toHaveBeenCalledWith({
      where: {
        accessToId: VERSION_ID,
        accessToType: 'ModelVersion',
        accessorId: BUYER_ID,
        accessorType: 'User',
      },
    });
    expect(mockDbWrite.entityAccess.delete).not.toHaveBeenCalled();
    expect(mockTx.model.update).toHaveBeenCalled();
  });

  it('refuses to refund from an owner account that cannot cover the total', async () => {
    setupRefundData();
    setupUnpublishWrites();
    mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 10 });

    await expect(
      unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, refundEarlyAccess: true })
    ).rejects.toThrowError(/requires 300 Buzz but the account only has 10/);
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('does not gate or refund on a moderator unpublish', async () => {
    setupRefundData();
    setupUnpublishWrites();

    await unpublishModelById({ id: MODEL_ID, userId: 1, isModerator: true });

    expect(mockDbWrite.paidAccess.findMany).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockTx.model.update).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Unit tests for getModelEarlyAccessRefundRequirement and the refundEarlyAccess gate in
// unpublishModelById. model.service.ts has a very large import graph, so most of its transitive
// service/db/search dependencies are stubbed out below to keep this a real unit test rather than
// an integration test. Mirrors the mock scaffold used in set-model-minor.service.test.ts.

// 🔴 `mockTx` stays a SEPARATE object from the write client. `mockTx.model.update` is asserted
// below and means "updated inside unpublishModelById's transaction"; the canonical `$transaction`
// default hands the callback `dbMock.dbWrite`, which would collapse that into the direct calls.
const { mockTx } = vi.hoisted(() => ({
  mockTx: {
    $queryRaw: vi.fn(),
    model: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
  },
}));

// Both entry points read and write on dbWrite throughout — `modelVersion.findMany`
// (model.service:2806), `entityAccess.findMany` and
// `.deleteMany` (:2915), `model.findUniqueOrThrow` (:2877), `$transaction` (:2967),
// `post.findMany` (:3028), `image.findMany` (:3032) — so the old alias's split was never exercised.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const {
  mockModelsQueueUpdate,
  mockQueueImageSearchIndexUpdate,
  mockDeleteBidsForModel,
  mockGetMultiAccountTransactionsByPrefix,
  mockGetUserBuzzAccountByAccountTypes,
  mockRefundMultiAccountTransaction,
} = vi.hoisted(() => ({
  mockModelsQueueUpdate: vi.fn(),
  mockQueueImageSearchIndexUpdate: vi.fn(),
  mockDeleteBidsForModel: vi.fn(),
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
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

// Either side of the 30-day purchase window.
const WINDOW_DAYS = 30;
const boughtLongAgo = () => new Date(Date.now() - (WINDOW_DAYS + 1) * 24 * HOUR);
const boughtRecently = () => new Date(Date.now() - (WINDOW_DAYS - 1) * 24 * HOUR);

type VersionRow = { id: number; meta: Record<string, unknown> | null };
type GateRow = { entityId: number; endsAt: Date | null };
type AccessRow = {
  accessToId: number;
  accessorId: number;
  meta: Record<string, unknown> | null;
  addedAt: Date | null;
};

function setupRefundData({
  versions = [{ id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } }] as VersionRow[],
  gates = [{ entityId: VERSION_ID, endsAt: null }] as GateRow[],
  accessRows = [
    {
      accessToId: VERSION_ID,
      accessorId: BUYER_ID,
      meta: { 'download-buzzTransactionId': 'tx-1' },
      addedAt: boughtRecently(),
    },
  ] as AccessRow[],
  amounts = { 'tx-1': 300 } as Record<string, number>,
  // The account each purchase was PAID FROM. The ledger reports legs by the buyer's account, which
  // is what the payout account is derived from.
  spentFrom = {} as Record<string, string>,
} = {}) {
  mockDbWrite.modelVersion.findMany.mockResolvedValue(versions);
  // 🔴 Still seeded although the requirement no longer reads PaidAccess — see the note in
  // model-version.unpublish-refund.service.test.ts. Removing it defuses the gate-state tests.
  mockDbWrite.paidAccess.findMany.mockResolvedValue(gates);
  mockDbWrite.entityAccess.findMany.mockResolvedValue(accessRows);
  mockGetMultiAccountTransactionsByPrefix.mockImplementation(async (prefix: string) => [
    { amount: amounts[prefix] ?? 0, accountType: spentFrom[prefix] ?? 'yellow' },
  ]);
}

function setupModelStatus(status: string) {
  mockTx.model.findUniqueOrThrow.mockResolvedValue({ status });
}

function setupUnpublishWrites({
  // What the model update reports back: EVERY version of the model, drafts included — it carries no
  // where clause. Distinct from the transitioning set below, and conflating the two is the bug this
  // fixture exists to expose.
  allVersionIds = [VERSION_ID, OTHER_VERSION_ID],
  transitioningVersionIds = [VERSION_ID],
}: { allVersionIds?: number[]; transitioningVersionIds?: number[] } = {}) {
  mockTx.$executeRaw.mockResolvedValue(transitioningVersionIds.length);
  // Default: an ordinary published model. The violation cases override it.
  setupModelStatus('Published');
  mockTx.model.update.mockResolvedValue({
    userId: OWNER_ID,
    modelVersions: allVersionIds.map((id) => ({ id })),
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
  it('returns nothing and reads no grants when no version was ever purchased', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValue([
      { id: VERSION_ID, meta: null },
      { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: false } },
    ]);

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result).toEqual({
      purchases: [],
      buyerCount: 0,
      totalBuzz: 0,
      totalsByAccount: {},
      exemptBuyerCount: 0,
    });
    expect(mockDbWrite.entityAccess.findMany).not.toHaveBeenCalled();
  });

  // Inverted deliberately. This asserted that a lapsed window exempts the seller; it no longer does,
  // because the gate's state is something the creator can change and a purchase is not. A lapsed
  // early-access window bought the buyer some days of access, not the right to lose the version.
  it('still owes a refund when the early access window has lapsed but the purchase is recent', async () => {
    setupRefundData({ gates: [{ entityId: VERSION_ID, endsAt: past() }] });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result).toEqual({
      purchases: [{ modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] }],
      buyerCount: 1,
      totalBuzz: 300,
      totalsByAccount: { yellow: 300 },
      exemptBuyerCount: 0,
    });
  });

  // The hole this predicate exists to close: clearing the gate is one ordinary editor save away.
  it('still owes a refund when the gate row is gone entirely', async () => {
    setupRefundData({ gates: [] });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.buyerCount).toBe(1);
    expect(result.totalBuzz).toBe(300);
  });

  it('looks at grants on every purchased version, whatever its gate says', async () => {
    setupRefundData({
      versions: [
        { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true }, publishedAt: past() },
        { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: true }, publishedAt: past() },
      ],
      gates: [
        { entityId: VERSION_ID, endsAt: future() },
        { entityId: OTHER_VERSION_ID, endsAt: past() },
      ],
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(mockDbWrite.entityAccess.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accessToId: { in: [VERSION_ID, OTHER_VERSION_ID] } }),
      })
    );
    expect(result.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] },
    ]);
  });

  it('skips grants with no purchase transaction and sums both download and generation purchases', async () => {
    setupRefundData({
      versions: [
        { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true }, publishedAt: past() },
        { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: true }, publishedAt: past() },
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
          addedAt: boughtRecently(),
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

  it('books each purchase against the owner account its currency paid into', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: {
            'download-buzzTransactionId': 'tx-1',
            'generation-buzzTransactionId': 'tx-2',
          },
          addedAt: boughtRecently(),
        },
        {
          accessToId: VERSION_ID,
          accessorId: OTHER_BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-3' },
          addedAt: boughtRecently(),
        },
      ],
      amounts: { 'tx-1': 300, 'tx-2': 200, 'tx-3': 25 },
      // Green is a buyer-side currency that pays the owner in yellow, so it must land in the
      // yellow bucket rather than one of its own.
      spentFrom: { 'tx-1': 'blue', 'tx-2': 'green', 'tx-3': 'yellow' },
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.totalsByAccount).toEqual({ blue: 300, yellow: 225 });
    expect(result.totalBuzz).toBe(525);
  });

  it('drops purchases made longer ago than the window and counts those buyers as exempt', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-1' },
          addedAt: boughtLongAgo(),
        },
      ],
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.purchases).toEqual([]);
    expect(result.totalBuzz).toBe(0);
    expect(result.exemptBuyerCount).toBe(1);
    // Nothing is priced for an exempt buyer — the ledger is never asked.
    expect(mockGetMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
  });

  it('refunds the recent buyer and exempts the old one on the same version', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-1' },
          addedAt: boughtRecently(),
        },
        {
          accessToId: VERSION_ID,
          accessorId: OTHER_BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-2' },
          addedAt: boughtLongAgo(),
        },
      ],
      amounts: { 'tx-1': 300, 'tx-2': 900 },
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] },
    ]);
    expect(result.buyerCount).toBe(1);
    expect(result.exemptBuyerCount).toBe(1);
    // The exempt buyer's 900 must not reach the total the owner is asked to pay.
    expect(result.totalBuzz).toBe(300);
  });

  it('counts a buyer once when several of their purchases have aged out', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-1' },
          addedAt: boughtLongAgo(),
        },
        {
          accessToId: OTHER_VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-2' },
          addedAt: boughtLongAgo(),
        },
      ],
      versions: [
        { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
        { id: OTHER_VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
      ],
      gates: [
        { entityId: VERSION_ID, endsAt: null },
        { entityId: OTHER_VERSION_ID, endsAt: null },
      ],
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.exemptBuyerCount).toBe(1);
  });

  it('keeps owing a refund on a purchase with no recorded date', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-1' },
          addedAt: null,
        },
      ],
    });

    const result = await getModelEarlyAccessRefundRequirement({ id: MODEL_ID });

    expect(result.purchases).toHaveLength(1);
    expect(result.exemptBuyerCount).toBe(0);
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
          addedAt: boughtRecently(),
        },
      ],
      amounts: { 'tx-1': 300, 'tx-2': 200 },
    });
    setupUnpublishWrites();
    mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 1000 });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, refundEarlyAccess: true });

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    // The buyer reads this line in their Buzz history, so it has to name what was taken down.
    // Nothing else pins the model wording — the scope argument defaults, and a flipped default
    // is invisible to every other assertion in both refund suites.
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('(model unpublished)'),
      })
    );
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
    ).rejects.toThrowError(/requires 300 yellow Buzz but the account only has 10/);
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  // The two halves of the same bug: the guard used to read yellow for every purchase regardless of
  // what funded it, so a blue-funded sale both blocked an unpublish it shouldn't have and sailed
  // past one it should have caught. The ledger exempts refunds from its own sufficiency check, so
  // this guard is the only thing standing between a creator and a negative balance.
  it('lets a blue-funded refund through on blue balance alone, with no yellow to its name', async () => {
    setupRefundData({ spentFrom: { 'tx-1': 'blue' } });
    setupUnpublishWrites();
    mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ blue: 300, yellow: 0 });

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, refundEarlyAccess: true });

    expect(mockGetUserBuzzAccountByAccountTypes).toHaveBeenCalledWith(OWNER_ID, ['blue']);
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledTimes(1);
    expect(mockTx.model.update).toHaveBeenCalled();
  });

  it('refuses when a covered yellow balance hides an uncovered blue one', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: {
            'download-buzzTransactionId': 'tx-1',
            'generation-buzzTransactionId': 'tx-2',
          },
          addedAt: boughtRecently(),
        },
      ],
      amounts: { 'tx-1': 300, 'tx-2': 500 },
      spentFrom: { 'tx-1': 'yellow', 'tx-2': 'blue' },
    });
    setupUnpublishWrites();
    mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: 10_000, blue: 0 });

    await expect(
      unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, refundEarlyAccess: true })
    ).rejects.toThrowError(/requires 500 blue Buzz but the account only has 0/);
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });

  it('unpublishes without consent or refunds once every buyer has aged out', async () => {
    setupRefundData({
      accessRows: [
        {
          accessToId: VERSION_ID,
          accessorId: BUYER_ID,
          meta: { 'download-buzzTransactionId': 'tx-1' },
          addedAt: boughtLongAgo(),
        },
      ],
    });
    setupUnpublishWrites();

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.entityAccess.deleteMany).not.toHaveBeenCalled();
    expect(mockTx.model.update).toHaveBeenCalled();
  });

  // The gate rests entirely on hadEarlyAccessPurchase now that PaidAccess is out of the predicate,
  // and this is the one operation that used to destroy it: the version rows were written with the
  // MODEL's meta object, replacing the column. An owner could unpublish, shedding the flag, and then
  // delete the version with every guard that reads it gone.
  // The take-down is one raw statement: status and meta together, scoped by the model and the two
  // statuses. These read the SQL itself, because the two properties that matter — that meta is
  // MERGED rather than replaced, and that the WHERE picks the transitioning rows — live entirely in
  // the static template segments. An assertion on the interpolated payload is byte-identical under
  // `meta = COALESCE(meta,'{}') || payload` and under `meta = payload`, which is the bug this code
  // exists to prevent.
  // The take-down is the first $executeRaw in the transaction; the Post metadata update is the
  // second. Found by its SQL rather than by position, so reordering cannot silently repoint these.
  const takeDownCall = () =>
    mockTx.$executeRaw.mock.calls.find(([strings]) =>
      (strings as unknown as string[]).join('').includes('UPDATE "ModelVersion"')
    );
  const takeDownSql = () =>
    ((takeDownCall()?.[0] ?? []) as unknown as string[]).join('?').replace(/\s+/g, ' ');
  const takeDownParams = () => takeDownCall()?.slice(1) ?? [];

  it('merges the unpublish keys into each version meta instead of replacing it', async () => {
    setupRefundData({ accessRows: [] });
    setupUnpublishWrites();

    // A reason means a moderator now — an owner supplying one is refused outright.
    await unpublishModelById({
      id: MODEL_ID,
      userId: OWNER_ID,
      isModerator: true,
      reason: 'duplicate',
    });

    expect(takeDownSql()).toContain(
      `SET "status" = ?::"ModelStatus", "meta" = COALESCE("meta", '{}'::jsonb) ||`
    );
    // Every key the notification and the audit trail read, not just the one that is easiest to find.
    expect(JSON.parse(takeDownParams()[1] as string)).toEqual({
      unpublishedReason: 'duplicate',
      customMessage: undefined,
      unpublishedAt: expect.any(String),
      unpublishedBy: OWNER_ID,
    });
    // A reasoned take-down puts the VERSION at UnpublishedViolation, which the nested updateMany
    // this replaced did not do — it always wrote plain Unpublished. That difference decides whether
    // an owner can republish the version afterwards, and it is what restore-models has to match.
    expect(takeDownParams()[0]).toBe('UnpublishedViolation');
    expect(mockTx.model.update.mock.calls[0][0].data.status).toBe('UnpublishedViolation');
    // And the version's updatedAt is stamped — raw SQL gets no @updatedAt.
    expect(takeDownSql()).toContain('"updatedAt" = NOW()');
  });

  it('takes down only the versions that were published or scheduled', async () => {
    setupRefundData({ accessRows: [] });
    setupUnpublishWrites();

    await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

    const sql = takeDownSql();
    expect(sql).toContain('WHERE "modelId" = ?');
    expect(sql).toContain('AND "status" IN (?::"ModelStatus", ?::"ModelStatus")');
    // Exact, not substring: the params carry an ISO timestamp whose millisecond field makes a
    // substring search on a 3-digit id both flaky and misleading.
    expect(takeDownParams()).toEqual([
      'Unpublished',
      expect.any(String),
      MODEL_ID,
      'Published',
      'Scheduled',
    ]);
  });

  // 🔴 An owner-initiated unpublish carries no reason. Writing the status unconditionally would put
  // a model a moderator took down back to plain Unpublished — and owner republish is blocked only
  // WHILE the status is UnpublishedViolation, so that is an owner-reachable way to clear the flag.
  describe('a model already taken down for a violation', () => {
    it('keeps the violation status through a reasonless unpublish', async () => {
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('UnpublishedViolation');

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

      expect(mockTx.model.update.mock.calls[0][0].data.status).toBe('UnpublishedViolation');
    });

    it('decides from the STATUS, not from a reason in meta', async () => {
      // 2,327 of 43,492 violation rows in prod carry no reason in meta. Keying the guard on meta
      // fails open for exactly the rows nobody wrote through this code.
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('UnpublishedViolation');

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, meta: {} });

      expect(mockTx.model.update.mock.calls[0][0].data.status).toBe('UnpublishedViolation');
    });

    it('leaves the moderator record intact — actor, explanation and timestamp', async () => {
      // customMessage is the ONLY explanation rendered when the reason is 'other', which is the
      // largest bucket in prod; and refreshing unpublishedAt re-fires the take-down notification.
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('UnpublishedViolation');
      const moderatorRecord = {
        unpublishedReason: 'other',
        customMessage: 'Reviewed by a human',
        unpublishedAt: '2020-01-01T00:00:00.000Z',
        unpublishedBy: 999,
      };

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, meta: { ...moderatorRecord } });

      expect(mockTx.model.update.mock.calls[0][0].data.meta).toEqual(moderatorRecord);
    });

    // Negative control: a guard that preserved unconditionally would leave every ordinary unpublish
    // unrecorded, and each assertion above would still pass.
    it('still stamps an ordinary unpublish of a model that carries no violation', async () => {
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

      const data = mockTx.model.update.mock.calls[0][0].data;
      expect(data.status).toBe('Unpublished');
      expect(data.meta).toEqual(
        expect.objectContaining({ unpublishedBy: OWNER_ID, unpublishedAt: expect.any(String) })
      );
    });

    // The too-wide direction. A guard that also fired on a stale `meta.unpublishedReason` would
    // escalate ordinary owner unpublishes to UnpublishedViolation for any model taken down once and
    // republished since — and every assertion above would still pass.
    it('does not escalate a published model carrying a stale reason in meta', async () => {
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('Published');

      await unpublishModelById({
        id: MODEL_ID,
        userId: OWNER_ID,
        meta: { unpublishedReason: 'duplicate', customMessage: 'from a previous take-down' },
      });

      expect(mockTx.model.update.mock.calls[0][0].data.status).toBe('Unpublished');
    });

    it('preserves Deleted too, not UnpublishedViolation alone', async () => {
      // Deleted is the other moderator-only status; clearing it clears the republish gate and
      // publishModelById then nulls deletedAt, completing an owner-driven restore.
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('Deleted');

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

      expect(mockTx.model.update.mock.calls[0][0].data.status).toBe('Deleted');
    });

    it('takes the versions down without restamping their meta', async () => {
      // The version rows are what unpublish.notifications.ts selects on, per version, with no
      // status predicate. Merging unpublishedAt into them on a preserved take-down re-fires the
      // notification with the owner named as the actor of a moderator's decision.
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('UnpublishedViolation');

      await unpublishModelById({ id: MODEL_ID, userId: OWNER_ID });

      expect(takeDownParams()[0]).toBe('UnpublishedViolation');
      expect(JSON.parse(takeDownParams()[1] as string)).toEqual({});
    });

    it('refuses a reason from someone who is not a moderator', async () => {
      // Otherwise the guard's precondition — "an owner-initiated unpublish carries no reason" — is
      // an assumption, and an owner can rewrite the moderator's verdict by supplying one.
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();

      await expect(
        unpublishModelById({ id: MODEL_ID, userId: OWNER_ID, reason: 'duplicate' })
      ).rejects.toThrowError(/Only a moderator/);

      expect(mockTx.model.update).not.toHaveBeenCalled();
    });

    // A moderator acting deliberately still writes their own verdict over the old one.
    it('lets a moderator restate the violation with a new reason', async () => {
      setupRefundData({ accessRows: [] });
      setupUnpublishWrites();
      setupModelStatus('UnpublishedViolation');

      await unpublishModelById({
        id: MODEL_ID,
        userId: 999,
        isModerator: true,
        reason: 'duplicate',
        customMessage: 'new note',
        meta: { unpublishedReason: 'other', customMessage: 'old' },
      });

      const data = mockTx.model.update.mock.calls[0][0].data;
      expect(data.status).toBe('UnpublishedViolation');
      // All four, not two: a customMessage falling back to the stored one leaves a new verdict
      // carrying the old explanation.
      expect(data.meta).toEqual({
        unpublishedReason: 'duplicate',
        customMessage: 'new note',
        unpublishedAt: expect.any(String),
        unpublishedBy: 999,
      });
    });
  });

  it('does not gate or refund on a moderator unpublish', async () => {
    setupRefundData();
    setupUnpublishWrites();

    await unpublishModelById({ id: MODEL_ID, userId: 1, isModerator: true });

    // A moderator take-down must not even price the refund — that read is the owner's gate.
    expect(mockDbWrite.entityAccess.findMany).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockTx.model.update).toHaveBeenCalled();
  });
});

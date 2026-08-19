import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The refund gate on unpublishModelVersionById. Unpublishing a version revokes its buyers' access,
// so the same obligation the model-level unpublish enforces has to hold at version scope — the gate
// was absent here while the model-level one shipped, and the endpoint is owner-reachable.
//
// model-version.service.ts has a very large import graph; the transitive service/search dependencies
// are stubbed below to keep this a unit test, and the db comes from the canonical dbMock. The refund
// module itself is deliberately NOT mocked — it is the thing being reused.

const { mockTx } = vi.hoisted(() => ({
  // Separate from the write client on purpose: modelVersion.update is asserted as "inside the
  // transaction", which collapses if $transaction hands back dbWrite itself.
  mockTx: {
    modelVersion: { update: vi.fn() },
    $executeRaw: vi.fn(),
  },
}));

const {
  mockGetMultiAccountTransactionsByPrefix,
  mockRefundMultiAccountTransaction,
  mockGetUserBuzzAccountByAccountTypes,
} = vi.hoisted(() => ({
  mockGetMultiAccountTransactionsByPrefix: vi.fn(),
  mockRefundMultiAccountTransaction: vi.fn(),
  mockGetUserBuzzAccountByAccountTypes: vi.fn(),
}));

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/paid-access.service', () => ({
  materializePaidAccessEndsAt: vi.fn(),
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: mockGetMultiAccountTransactionsByPrefix,
  getUserBuzzAccountByAccountTypes: mockGetUserBuzzAccountByAccountTypes,
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: vi.fn(),
  ensureDonationGoal: vi.fn(),
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));

import { unpublishModelVersionById } from '~/server/services/model-version.service';
import { getModelVersionEarlyAccessRefundRequirement } from '~/server/services/model-early-access-refund.service';
import type { SessionUser } from '~/types/session';

const MODEL_ID = 42;
const OWNER_ID = 7;
const VERSION_ID = 100;
const OTHER_VERSION_ID = 101;
const BUYER_ID = 555;

const HOUR = 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const boughtRecently = () => new Date(Date.now() - (WINDOW_DAYS - 1) * 24 * HOUR);
const boughtLongAgo = () => new Date(Date.now() - (WINDOW_DAYS + 1) * 24 * HOUR);

const owner = { id: OWNER_ID, isModerator: false } as SessionUser;
const moderator = { id: 9, isModerator: true } as SessionUser;

function seedPurchase({
  addedAt = boughtRecently(),
  amount = 300,
  balance = 10_000,
}: { addedAt?: Date | null; amount?: number; balance?: number } = {}) {
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    { id: VERSION_ID, meta: { hadEarlyAccessPurchase: true } },
  ]);
  dbMock.dbWrite.paidAccess.findMany.mockResolvedValue([{ entityId: VERSION_ID, endsAt: null }]);
  dbMock.dbWrite.entityAccess.findMany.mockResolvedValue([
    {
      accessToId: VERSION_ID,
      accessorId: BUYER_ID,
      meta: { 'download-buzzTransactionId': 'tx-1' },
      addedAt,
    },
  ]);
  mockGetMultiAccountTransactionsByPrefix.mockResolvedValue([{ amount, accountType: 'yellow' }]);
  mockGetUserBuzzAccountByAccountTypes.mockResolvedValue({ yellow: balance });
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ modelId: MODEL_ID });
  dbMock.dbWrite.model.findUniqueOrThrow.mockResolvedValue({ name: 'Test Model', userId: OWNER_ID });
}

function seedUnpublishWrites() {
  mockTx.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    model: { id: MODEL_ID, userId: OWNER_ID, nsfw: false },
  });
  dbMock.dbWrite.post.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$transaction.mockImplementation((fn: (tx: typeof mockTx) => unknown) => fn(mockTx));
  seedUnpublishWrites();
});

describe('getModelVersionEarlyAccessRefundRequirement', () => {
  it('asks only for the version it was given, not every version on the model', async () => {
    seedPurchase();

    await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(dbMock.dbWrite.modelVersion.findMany).toHaveBeenCalledWith({
      where: { id: VERSION_ID },
      select: { id: true, meta: true },
    });
  });

  it('owes the refund on a recent purchase', async () => {
    seedPurchase();

    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(requirement.buyerCount).toBe(1);
    expect(requirement.totalBuzz).toBe(300);
    expect(requirement.purchases).toEqual([
      { modelVersionId: VERSION_ID, buyerId: BUYER_ID, buzzTransactionIds: ['tx-1'] },
    ]);
  });

  it('owes nothing on a purchase older than the window, and counts that buyer as exempt', async () => {
    seedPurchase({ addedAt: boughtLongAgo() });

    const requirement = await getModelVersionEarlyAccessRefundRequirement({ id: VERSION_ID });

    expect(requirement.purchases).toEqual([]);
    expect(requirement.exemptBuyerCount).toBe(1);
  });
});

describe('unpublishModelVersionById — refund gate', () => {
  it('refuses the unpublish when the owner has not consented to refunding', async () => {
    seedPurchase();

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    // The point of the gate: the version is still published and nobody has been charged.
    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('refunds the buyer, revokes the grant, then unpublishes when the owner consents', async () => {
    seedPurchase();

    await unpublishModelVersionById({ id: VERSION_ID, refundEarlyAccess: true, user: owner });

    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith({
      externalTransactionIdPrefix: 'tx-1',
      description: 'Refund early access purchase: Test Model (version unpublished)',
    });
    expect(dbMock.dbWrite.entityAccess.deleteMany).toHaveBeenCalledWith({
      where: {
        accessToId: VERSION_ID,
        accessToType: 'ModelVersion',
        accessorId: BUYER_ID,
        accessorType: 'User',
      },
    });
    expect(mockTx.modelVersion.update).toHaveBeenCalled();
  });

  it('refuses to refund from an owner account that cannot cover the total', async () => {
    seedPurchase({ amount: 300, balance: 100 });

    await expect(
      unpublishModelVersionById({ id: VERSION_ID, refundEarlyAccess: true, user: owner })
    ).rejects.toThrowError(/300 yellow Buzz but the account only has 100/);

    expect(mockTx.modelVersion.update).not.toHaveBeenCalled();
  });

  it('unpublishes without consent once every buyer has aged out of the window', async () => {
    seedPurchase({ addedAt: boughtLongAgo() });

    await unpublishModelVersionById({ id: VERSION_ID, user: owner });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('does not gate or refund on a moderator unpublish', async () => {
    seedPurchase();

    await unpublishModelVersionById({ id: VERSION_ID, reason: 'duplicate', user: moderator });

    expect(mockTx.modelVersion.update).toHaveBeenCalled();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    // A moderator take-down must not even price the refund — that read is the owner's gate.
    expect(dbMock.dbWrite.paidAccess.findMany).not.toHaveBeenCalled();
  });

  it('prices the refund from this version alone, not from its siblings', async () => {
    seedPurchase();
    dbMock.dbWrite.entityAccess.findMany.mockResolvedValue([
      {
        accessToId: VERSION_ID,
        accessorId: BUYER_ID,
        meta: { 'download-buzzTransactionId': 'tx-1' },
        addedAt: boughtRecently(),
      },
      {
        accessToId: OTHER_VERSION_ID,
        accessorId: BUYER_ID,
        meta: { 'download-buzzTransactionId': 'tx-2' },
        addedAt: boughtRecently(),
      },
    ]);

    await expect(unpublishModelVersionById({ id: VERSION_ID, user: owner })).rejects.toThrowError(
      /without refunding buyers/
    );

    // Only this version's gate is read, so a sibling's buyers can never be dragged into the total.
    expect(dbMock.dbWrite.paidAccess.findMany).toHaveBeenCalledWith({
      where: { entityType: 'ModelVersion', entityId: { in: [VERSION_ID] } },
      select: { entityId: true, endsAt: true },
    });
  });
});

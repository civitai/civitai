import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisClient from '@civitai/redis/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Blue Buzz for paid access. A blue purchase must credit the owner blue, or it turns non-withdrawable
// credit into withdrawable currency. `toAccountType` defaults to yellow in buzz.service.

const {
  mockCreateMultiAccountBuzzTransaction,
  mockGetPaidAccess,
  mockGetFreshSalesForVersion,
  mockGetCachedCapTier,
  mockGetFreshSalesForPermanentGate,
  mockGetOwnerDonationGoals,
  mockHasEntityAccess,
  mockCheckDonationGoalComplete,
} = vi.hoisted(() => ({
  mockCreateMultiAccountBuzzTransaction: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockGetFreshSalesForVersion: vi.fn(),
  mockGetCachedCapTier: vi.fn(),
  mockGetFreshSalesForPermanentGate: vi.fn(),
  mockGetOwnerDonationGoals: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockCheckDonationGoalComplete: vi.fn(),
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
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof RedisClient>('@civitai/redis/client');
  return {
    ...actual,
    redis: { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(undefined) },
    sysRedis: { get: vi.fn() },
  };
});
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/paid-access.service', () => ({
  materializePaidAccessEndsAt: vi.fn(),
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: mockGetPaidAccess,
  getFreshSalesForVersion: mockGetFreshSalesForVersion,
  getFreshSalesForPermanentGate: mockGetFreshSalesForPermanentGate,
  getCachedCapTier: mockGetCachedCapTier,
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: mockCreateMultiAccountBuzzTransaction,
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: mockHasEntityAccess }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: mockCheckDonationGoalComplete,
  ensureDonationGoal: vi.fn(),
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: mockGetOwnerDonationGoals,
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { earlyAccessPurchase } from '~/server/services/model-version.service';

const OWNER = 10;
const BUYER = 20;
const VERSION_ID = 555;

const seed = ({
  acceptsBlueBuzz = false,
  goal = null as { id: number; active: boolean } | null,
} = {}) => {
  const versionRow = {
    id: VERSION_ID,
    status: 'Published',
    name: 'v1',
    meta: { hadEarlyAccessPurchase: true },
    baseModel: 'SDXL 1.0',
    model: { id: 1, name: 'Model', userId: OWNER, nsfw: false },
  };
  // getDbWithoutLag('modelVersion', id) returns dbRead when REPLICATION_LAG_DELAY=0;
  // earlyAccessPurchase calls getVersionById which uses it. Set up both sides so
  // the test is correct regardless of which client the service routes through.
  dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(versionRow);
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(versionRow);
  mockGetPaidAccess.mockResolvedValue({
    [VERSION_ID]: {
      entityType: 'ModelVersion',
      entityId: VERSION_ID,
      ownerId: OWNER,
      // A timed window: no price cap lookup, so the charge is the stored price.
      endsAt: new Date(Date.now() + 86_400_000),
      timeframeDays: 3,
      terms: { download: { price: 500 }, ...(acceptsBlueBuzz ? { acceptsBlueBuzz: true } : {}) },
    },
  });
  mockGetOwnerDonationGoals.mockResolvedValue(goal ? { [VERSION_ID]: goal } : {});
  mockHasEntityAccess.mockResolvedValue([{ hasAccess: false, permissions: 0, meta: null }]);
  dbMock.dbRead.entityAccess.findFirst.mockResolvedValue(null);
  dbMock.dbRead.entityAccess.upsert.mockResolvedValue({});
  dbMock.dbWrite.entityAccess.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.entityAccess.upsert.mockResolvedValue({});
  mockCreateMultiAccountBuzzTransaction.mockResolvedValue({
    transactionCount: 1,
    transactionIds: [],
  });
  mockGetFreshSalesForVersion.mockResolvedValue([]);
  mockGetFreshSalesForPermanentGate.mockResolvedValue([]);
  mockGetCachedCapTier.mockResolvedValue(null);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('earlyAccessPurchase — Blue Buzz', () => {
  it('credits the owner in the SAME colour the buyer spent (no blue→yellow conversion)', async () => {
    seed({ acceptsBlueBuzz: true });

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'blue',
    });

    const charge = mockCreateMultiAccountBuzzTransaction.mock.calls[0][0];
    expect(charge.fromAccountTypes).toEqual(['blue']);
    expect(charge.toAccountType).toBe('blue');
  });

  // Every currency pays into itself. Green used to land in yellow — not by decision but because the
  // charge named no destination account and the buzz service applied its yellow default, so every
  // green purchase from 2025-10-30 paid the seller a currency the buyer never spent.
  it.each(['green', 'yellow'] as const)('pays a %s purchase in kind', async (buzzType) => {
    seed({ acceptsBlueBuzz: true });

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType,
    });

    const charge = mockCreateMultiAccountBuzzTransaction.mock.calls[0][0];
    expect(charge.fromAccountTypes).toEqual([buzzType]);
    expect(charge.toAccountType).toBe(buzzType);
  });

  it('rejects blue when the creator has not opted in', async () => {
    seed({ acceptsBlueBuzz: false });

    await expect(
      earlyAccessPurchase({
        userId: BUYER,
        modelVersionId: VERSION_ID,
        type: 'download',
        buzzType: 'blue',
      })
    ).rejects.toThrow(/does not accept Blue Buzz/);
    expect(mockCreateMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('does not advance a donation goal on a blue purchase', async () => {
    seed({ acceptsBlueBuzz: true, goal: { id: 77, active: true } });

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'blue',
    });

    expect(dbMock.dbWrite.donation.create).not.toHaveBeenCalled();
    expect(mockCheckDonationGoalComplete).not.toHaveBeenCalled();
  });

  it('still advances a donation goal on a domain-currency purchase', async () => {
    seed({ acceptsBlueBuzz: true, goal: { id: 77, active: true } });

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'green',
    });

    expect(dbMock.dbWrite.donation.create).toHaveBeenCalledTimes(1);
  });
});

describe('earlyAccessPurchase — a scheduled sale is priced from the PRIMARY, not the cached gate', () => {
  const liveSale = {
    id: 1,
    discountType: 'Percent' as const,
    discountAmount: 20,
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000),
    canceledAt: null,
  };

  const charged = () => mockCreateMultiAccountBuzzTransaction.mock.calls[0][0].amount;

  it('charges the discounted price when a sale is live', async () => {
    seed();
    mockGetFreshSalesForPermanentGate.mockResolvedValue([liveSale]);

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'yellow',
    });

    expect(charged()).toBe(400);
    // Exactly one charge. Asserting only the amount would stay green if the buyer were billed twice.
    expect(mockCreateMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    // These fixtures are a TIMED gate, where sales must not apply — pin that the charge says so.
    expect(mockGetFreshSalesForPermanentGate).toHaveBeenCalledWith(VERSION_ID, false, OWNER);
  });

  it('charges full price the moment a sale is cancelled, even though the cached gate still carries it', async () => {
    // The gate row is cached for an hour and Creator Studio's bust is fire-and-forget, so the cached copy
    // can still describe a sale the creator has already ended. The charge reads the primary instead —
    // this test fails if the purchase path is ever repointed at the cached window.
    seed();
    mockGetPaidAccess.mockResolvedValue({
      [VERSION_ID]: {
        entityType: 'ModelVersion',
        entityId: VERSION_ID,
        ownerId: OWNER,
        endsAt: new Date(Date.now() + 86_400_000),
        timeframeDays: 3,
        terms: { download: { price: 500 } },
        sales: [liveSale],
      },
    });
    mockGetFreshSalesForPermanentGate.mockResolvedValue([]);

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'yellow',
    });

    expect(charged()).toBe(500);
    expect(mockCreateMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
  });

  it('moves NO money when a sale is live but the purchase is refused', async () => {
    // The negative control for the two above: a live sale must not become a reason money moves. Without
    // this, a resolver that charged before validating would pass every assertion in this file.
    seed();
    mockGetFreshSalesForPermanentGate.mockResolvedValue([liveSale]);
    const draftVersion = {
      id: VERSION_ID,
      status: 'Draft',
      name: 'v1',
      meta: {},
      baseModel: 'SDXL 1.0',
      model: { id: 1, name: 'Model', userId: OWNER, nsfw: false },
    };
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(draftVersion);
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue(draftVersion);

    await expect(
      earlyAccessPurchase({
        userId: BUYER,
        modelVersionId: VERSION_ID,
        type: 'download',
        buzzType: 'yellow',
      })
    ).rejects.toThrow();

    expect(mockCreateMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.entityAccess.upsert).not.toHaveBeenCalled();
  });
});

describe('earlyAccessPurchase — a sale on a PERMANENT gate, where the price ceiling actually applies', () => {
  const liveSale = {
    id: 1,
    discountType: 'Percent' as const,
    discountAmount: 20,
    startsAt: new Date(Date.now() - 86_400_000),
    endsAt: new Date(Date.now() + 86_400_000),
    canceledAt: null,
  };

  const seedPermanent = (terms: Record<string, unknown> = { download: { price: 5000 } }) => {
    seed();
    // Every other sale fixture in this file uses a TIMED gate, where effectivePaidAccessPrice returns the
    // stored price untouched — so cap-then-discount is a no-op there and the ordering is unpinned. A
    // permanent gate with a lapsed owner is the only shape where the two orders differ.
    mockGetPaidAccess.mockResolvedValue({
      [VERSION_ID]: {
        entityType: 'ModelVersion',
        entityId: VERSION_ID,
        ownerId: OWNER,
        endsAt: null,
        timeframeDays: null,
        terms,
      },
    });
    mockGetCachedCapTier.mockResolvedValue(null);
  };

  const charged = () => mockCreateMultiAccountBuzzTransaction.mock.calls[0][0].amount;

  it('takes the sale off the CAPPED price, not the stored one', async () => {
    seedPermanent();
    mockGetFreshSalesForPermanentGate.mockResolvedValue([liveSale]);

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'yellow',
    });

    // 5000 stored -> 500 at the free cap -> 20% off -> 400. Discounting first gives 4000, which the cap
    // flattens back to 500 and the sale vanishes.
    expect(charged()).toBe(400);
    expect(mockCreateMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    // The gate type is what decides whether sales are consulted at all, so pin that it is passed.
    expect(mockGetFreshSalesForPermanentGate).toHaveBeenCalledWith(VERSION_ID, true, OWNER);
  });

  it('bills the capped price untouched when no sale is live', async () => {
    seedPermanent();

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'yellow',
    });

    expect(charged()).toBe(500);
  });

  it('discounts a GENERATION purchase too, not only a download', async () => {
    seedPermanent({ download: { price: 5000 }, generation: { price: 200 } });
    mockGetFreshSalesForPermanentGate.mockResolvedValue([liveSale]);

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'generation',
      buzzType: 'yellow',
    });

    // 200 is under the free cap, so the cap is a no-op and the sale takes 20%.
    expect(charged()).toBe(160);
  });

  it('never bills zero: the floor holds when a discount reaches the whole price', async () => {
    seedPermanent({ download: { price: 400 } });
    mockGetFreshSalesForPermanentGate.mockResolvedValue([
      { ...liveSale, discountType: 'Fixed' as const, discountAmount: 100_000 },
    ]);

    await earlyAccessPurchase({
      userId: BUYER,
      modelVersionId: VERSION_ID,
      type: 'download',
      buzzType: 'yellow',
    });

    // A zero-Buzz purchase writes no ledger row, and the 30-day refund path reads amounts back from it.
    expect(charged()).toBe(1);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as RedisClient from '@civitai/redis/client';

// Blue Buzz for paid access. A blue purchase must credit the owner blue, or it turns non-withdrawable
// credit into withdrawable currency. `toAccountType` defaults to yellow in buzz.service.

const { mockDbWrite } = vi.hoisted(() => ({
  mockDbWrite: {
    modelVersion: { findUnique: vi.fn() },
    entityAccess: { findFirst: vi.fn(), upsert: vi.fn() },
    donation: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

const {
  mockCreateMultiAccountBuzzTransaction,
  mockGetPaidAccess,
  mockGetOwnerDonationGoals,
  mockHasEntityAccess,
  mockCheckDonationGoalComplete,
} = vi.hoisted(() => ({
  mockCreateMultiAccountBuzzTransaction: vi.fn(),
  mockGetPaidAccess: vi.fn(),
  mockGetOwnerDonationGoals: vi.fn(),
  mockHasEntityAccess: vi.fn(),
  mockCheckDonationGoalComplete: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
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
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  filesForModelVersionCache: {},
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
  mockDbWrite.modelVersion.findUnique.mockResolvedValue({
    id: VERSION_ID,
    status: 'Published',
    name: 'v1',
    meta: { hadEarlyAccessPurchase: true },
    baseModel: 'SDXL 1.0',
    model: { id: 1, name: 'Model', userId: OWNER, nsfw: false },
  });
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
  mockDbWrite.entityAccess.findFirst.mockResolvedValue(null);
  mockDbWrite.entityAccess.upsert.mockResolvedValue({});
  mockCreateMultiAccountBuzzTransaction.mockResolvedValue({
    transactionCount: 1,
    transactionIds: [],
  });
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

  // Only blue overrides the destination. Green/yellow must keep falling through to the service's
  // yellow default, because refundModelEarlyAccessPurchases checks the owner's YELLOW balance before
  // reversing an unpublish — routing green purchases to green would block unpublishing with the
  // money sitting in an account the guard never reads.
  it.each(['green', 'yellow'] as const)(
    'leaves the payout account untouched for %s purchases',
    async (buzzType) => {
      seed({ acceptsBlueBuzz: true });

      await earlyAccessPurchase({
        userId: BUYER,
        modelVersionId: VERSION_ID,
        type: 'download',
        buzzType,
      });

      const charge = mockCreateMultiAccountBuzzTransaction.mock.calls[0][0];
      expect(charge.fromAccountTypes).toEqual([buzzType]);
      expect(charge.toAccountType).toBeUndefined();
    }
  );

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

    expect(mockDbWrite.donation.create).not.toHaveBeenCalled();
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

    expect(mockDbWrite.donation.create).toHaveBeenCalledTimes(1);
  });
});

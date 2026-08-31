import { dbMock } from '~/__tests__/mocks/db.mock';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression tests for three prod 500-floor bugs in model-version.service.ts:
//
//  Fix 2 — modelVersionDonationGoal: findFirstOrThrow (read→write fallback)
//    threw P2025 when the version genuinely doesn't exist → 500. A missing
//    version is NOT_FOUND (404).  (~10/3h)
//
//  Fix 4 — toggleModelVersionEngagement: a toggle racing itself hits the
//    (userId, modelVersionId) unique constraint (P2002) on create → 500.
//    A toggle is idempotent → treat P2002 as success.  (~3/3h)
//
//  Fix 5 — mergeVersions: every raw query interpolates Prisma.join(sourceVersionIds);
//    an empty array throws "Expected join([]) ...". Guard with a 400.  (~2/3h
//    is the generic join([]) signature; this is the in-file candidate site.)

import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

const { mockGetOwnerDonationGoals, mockMaterialize, mockMaxDays, mockMaxModels } = vi.hoisted(
  () => ({
    mockGetOwnerDonationGoals: vi.fn(),
    mockMaterialize: vi.fn(),
    mockMaxDays: vi.fn(),
    mockMaxModels: vi.fn(),
  })
);

vi.mock('~/server/utils/early-access-helpers', () => ({
  getMaxEarlyAccessDays: mockMaxDays,
  getMaxEarlyAccessModels: mockMaxModels,
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});

// Keep the heavy service/search-index graph out of the test module graph.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  // Privileged (moderator) reads below never touch this cache; stub it so the import resolves.
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  // bustMvCache (in the publish path below) refreshes these.
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
  materializePaidAccessEndsAt: mockMaterialize,
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn().mockResolvedValue({}),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: vi.fn(),
  ensureDonationGoal: vi.fn(),
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
}));

import {
  assertUserEarlyAccessLimits,
  mergeVersions,
  modelVersionDonationGoal,
  publishModelVersionsWithEarlyAccess,
  toggleModelVersionEngagement,
} from '~/server/services/model-version.service';

const p2025 = () =>
  new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: '1' });
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '1' });

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fix 2 — modelVersionDonationGoal → 404 when truly not found
// ---------------------------------------------------------------------------
// The privileged (owner/moderator) path is uncached and still runs the findFirstOrThrow
// read→primary-fallback→404 resolution. (The anonymous / non-owner public path is served from
// the shared cache — covered in model-version.donation-goals-cache.service.test.ts.)
describe('modelVersionDonationGoal (privileged path)', () => {
  it('throws NOT_FOUND (404) when the version is missing on both read and write', async () => {
    mockDbRead.modelVersion.findFirstOrThrow.mockRejectedValueOnce(p2025());
    mockDbWrite.modelVersion.findFirstOrThrow.mockRejectedValueOnce(p2025());

    let caught: unknown;
    try {
      await modelVersionDonationGoal({ id: 999, isModerator: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('NOT_FOUND');
  });

  it('still falls back to the primary on a replica miss (replica-lag path preserved)', async () => {
    mockDbRead.modelVersion.findFirstOrThrow.mockRejectedValueOnce(p2025());
    mockDbWrite.modelVersion.findFirstOrThrow.mockResolvedValueOnce({
      id: 1,
      modelId: 2,
      earlyAccessEndsAt: null,
      model: { userId: 7 },
    });
    mockGetOwnerDonationGoals.mockResolvedValueOnce({}); // no goal for this version

    const result = await modelVersionDonationGoal({ id: 1, isModerator: true });
    expect(result).toBeNull();
    expect(mockDbWrite.modelVersion.findFirstOrThrow).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — toggleModelVersionEngagement idempotent on P2002
// ---------------------------------------------------------------------------
describe('toggleModelVersionEngagement', () => {
  it('treats a P2002 create race as success (no throw)', async () => {
    mockDbWrite.modelVersionEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelVersionEngagement.create.mockRejectedValueOnce(p2002());

    await expect(
      toggleModelVersionEngagement({ userId: 1, versionId: 2, type: 'Notify' as any })
    ).resolves.toBeUndefined();
  });

  it('rethrows non-P2002 create errors', async () => {
    mockDbWrite.modelVersionEngagement.findUnique.mockResolvedValueOnce(null);
    mockDbWrite.modelVersionEngagement.create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      toggleModelVersionEngagement({ userId: 1, versionId: 2, type: 'Notify' as any })
    ).rejects.toThrow('db down');
  });

  // 868kurkc7. `ModelVersionEngagementType` has exactly ONE member today, so a
  // PK-addressed write here is not a bug yet — it becomes one the day a second value
  // is added, silently, because nothing in the code says so. Pinned as a shape.
  it.each(['deleteMany', 'updateMany'] as const)(
    'issues no PK-addressed write (%s branch)',
    async (branch) => {
      mockDbWrite.modelVersionEngagement.findUnique.mockResolvedValueOnce({
        type: branch === 'deleteMany' ? 'Notify' : 'Something',
      });
      mockDbWrite.modelVersionEngagement.deleteMany.mockResolvedValue({ count: 1 });
      mockDbWrite.modelVersionEngagement.updateMany.mockResolvedValue({ count: 1 });

      await toggleModelVersionEngagement({ userId: 1, versionId: 2, type: 'Notify' as any });

      // The EXACT where, not `objectContaining`: a loose matcher passes whether or
      // not `type` is in the filter, which is the whole property under test.
      expect(mockDbWrite.modelVersionEngagement[branch]).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 1,
            modelVersionId: 2,
            type: branch === 'deleteMany' ? 'Notify' : 'Something',
          },
        })
      );
      expect([
        ...mockDbWrite.modelVersionEngagement.delete.mock.calls,
        ...mockDbWrite.modelVersionEngagement.update.mock.calls,
      ]).toEqual([]);
    }
  );

  it('scopes each write by the type it READ', async () => {
    mockDbWrite.modelVersionEngagement.findUnique.mockResolvedValueOnce({ type: 'Something' });
    mockDbWrite.modelVersionEngagement.updateMany.mockResolvedValue({ count: 1 });

    await toggleModelVersionEngagement({ userId: 1, versionId: 2, type: 'Notify' as any });

    expect(mockDbWrite.modelVersionEngagement.updateMany).toHaveBeenCalledWith({
      where: { userId: 1, modelVersionId: 2, type: 'Something' },
      data: { type: 'Notify' },
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — mergeVersions empty-array guard
// ---------------------------------------------------------------------------
describe('mergeVersions', () => {
  it('throws a 400 (not a join([]) 500) when sourceVersionIds is empty', async () => {
    mockDbRead.model.findUniqueOrThrow.mockResolvedValueOnce({
      userId: 7,
      modelVersions: [
        {
          id: 100,
          name: 'target',
          description: '',
          status: 'Published',
          earlyAccessEndsAt: null,
          monetization: null,
          meta: null,
        },
      ],
    });

    let caught: unknown;
    try {
      await mergeVersions({
        modelId: 1,
        targetVersionId: 100,
        sourceVersionIds: [],
        fileTypeMappings: {} as any,
        appendDescriptions: false,
        userId: 7,
      } as any);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('BAD_REQUEST');
    // Critically: the transaction (where Prisma.join([]) would throw) is never entered.
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Complexity review §1a — a SCHEDULED early-access version must materialize endsAt
// ---------------------------------------------------------------------------
// The scheduled-publishing job flips status here WITHOUT passing publishedAt (it set it at schedule
// time). Before the fix, the materialize step was gated on `publishedAt !== undefined`, so it never
// ran → PaidAccess.endsAt stayed NULL, which is the encoding for a PERMANENT gate. A 7-day scheduled
// gate silently became permanent and never released.
describe('publishModelVersionsWithEarlyAccess — endsAt materialization', () => {
  const version = (over: Record<string, unknown> = {}) => ({
    id: 1,
    name: 'v1',
    baseModel: 'SDXL 1.0',
    publishedAt: new Date('2026-07-01T00:00:00.000Z'),
    model: { id: 2, userId: 7, name: 'm', nsfw: false, meta: null },
    ...over,
  });
  const primeUpdate = () => {
    mockDbWrite.modelVersion.update.mockResolvedValue({
      id: 1,
      modelId: 2,
      baseModel: 'SDXL 1.0',
      model: { userId: 7, id: 2, type: 'Checkpoint', nsfw: false },
    });
  };

  it('materializes from the version’s already-set publishedAt when the caller omits it (scheduled job)', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValueOnce([version()]);
    primeUpdate();

    await publishModelVersionsWithEarlyAccess({ modelVersionIds: [1], continueOnError: true });

    // The bug: this call never happened. The publishedAt write itself must NOT run (anti-bump).
    expect(mockMaterialize).toHaveBeenCalledWith(1, version().publishedAt, mockDbWrite);
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does NOT materialize when the version has no publishedAt and none is passed', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValueOnce([version({ publishedAt: null })]);
    primeUpdate();

    await publishModelVersionsWithEarlyAccess({ modelVersionIds: [1], continueOnError: true });

    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it('materializes from the passed publishedAt (and writes it) on the interactive path', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValueOnce([version({ publishedAt: null })]);
    primeUpdate();
    mockDbWrite.$executeRaw.mockResolvedValueOnce(1); // anti-bump write hit a mutable row

    const publishedAt = new Date('2026-08-01T00:00:00.000Z');
    await publishModelVersionsWithEarlyAccess({
      modelVersionIds: [1],
      publishedAt,
      continueOnError: true,
    });

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockMaterialize).toHaveBeenCalledWith(1, publishedAt, mockDbWrite);
  });
});

// ---------------------------------------------------------------------------
// assertUserEarlyAccessLimits — the unified user-level EA caps (one enforcement point for both the
// tRPC upsert and the REST early-access endpoint).
// ---------------------------------------------------------------------------
describe('assertUserEarlyAccessLimits', () => {
  // getUserEarlyAccessModelVersions runs a raw query on the replica.
  const primeActive = (ids: number[]) =>
    mockDbRead.$queryRaw.mockResolvedValueOnce(ids.map((id) => ({ id })));

  beforeEach(() => {
    mockMaxDays.mockReturnValue(30);
    mockMaxModels.mockReturnValue(2);
  });

  it('no-op for a moderator or a gate with no timeframeDays (permanent / ungated)', async () => {
    await assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 9999, isModerator: true });
    await assertUserEarlyAccessLimits({ userId: 1, timeframeDays: undefined });
    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled(); // never even queries active EA
  });

  it('throws when the requested days exceed the user max', async () => {
    mockMaxDays.mockReturnValue(7);
    await expect(assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 14 })).rejects.toThrow(
      'Early access days exceeds user limit'
    );
  });

  it('throws at the concurrent-model cap for a NEW version', async () => {
    primeActive([10, 11]); // already 2 active, cap is 2
    await expect(assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7 })).rejects.toThrow(
      /maximum number of early access models/i
    );
  });

  it('EXEMPTS re-saving a version already counted toward the cap', async () => {
    primeActive([10, 11]); // at cap, but versionId 10 is one of them
    await expect(
      assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7, versionId: 10 })
    ).resolves.toBeUndefined();
  });

  it('allows a new version while under the cap', async () => {
    primeActive([10]); // 1 active, cap is 2
    await expect(
      assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7 })
    ).resolves.toBeUndefined();
  });
});

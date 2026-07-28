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

const { mockDbRead, mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });
  const read = {
    modelVersion: mk(),
    donationGoal: mk(),
    model: mk(),
    $queryRaw: vi.fn(),
  };
  const write = {
    modelVersion: mk(),
    modelVersionEngagement: mk(),
    model: mk(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockDbRead: read, mockDbWrite: write };
});

const { mockGetOwnerDonationGoals, mockMaterialize } = vi.hoisted(() => ({
  mockGetOwnerDonationGoals: vi.fn(),
  mockMaterialize: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
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
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  // The `redis`/`sysRedis` client instances live on the app shim, NOT the
  // package (`...actual` only has the key consts + factory) — stub them so
  // importers like db-lag-helpers resolve the named export.
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
  materializePaidAccessEndsAt: mockMaterialize,
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
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
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({ filesForModelVersionCache: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import {
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
});

// ---------------------------------------------------------------------------
// Fix 5 — mergeVersions empty-array guard
// ---------------------------------------------------------------------------
describe('mergeVersions', () => {
  it('throws a 400 (not a join([]) 500) when sourceVersionIds is empty', async () => {
    mockDbRead.model.findUniqueOrThrow.mockResolvedValueOnce({
      userId: 7,
      modelVersions: [{ id: 100, name: 'target', description: '', status: 'Published', earlyAccessEndsAt: null, monetization: null, meta: null }],
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

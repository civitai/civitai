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

import { getPaidAccess } from '~/server/services/paid-access.service';
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
// mergeVersions file remaps touch only files of the versions being merged
// ---------------------------------------------------------------------------
describe('mergeVersions file remaps', () => {
  const OWNER = 7;
  const MODEL = 1;
  const TARGET = 100;
  const SOURCE = 101;
  const OTHER_OF_SAME_MODEL = 102;
  const FILE = 900;

  // Everything after step 1 is out of scope here: the transaction client knows only the two file
  // methods, so reaching any later step stops the run with this marker.
  const PAST_REMAP = 'reached the steps after the file remap';
  const fileFindMany = vi.fn();
  const fileUpdateMany = vi.fn();
  const versionRows = vi.fn(async () =>
    [TARGET, SOURCE].map((id) => ({
      id,
      name: `v${id}`,
      status: 'Published',
      trainingStatus: null,
    }))
  );
  const tx = new Proxy(
    { $queryRaw: versionRows, modelFile: { findMany: fileFindMany, updateMany: fileUpdateMany } },
    {
      get(target, key) {
        if (key in target) return target[key as keyof typeof target];
        throw new Error(PAST_REMAP);
      },
    }
  );

  const merge = (fileTypeMappings: { fileId: number; type?: string; metadata?: object }[]) =>
    mergeVersions({
      modelId: MODEL,
      targetVersionId: TARGET,
      sourceVersionIds: [SOURCE],
      fileTypeMappings,
      appendDescriptions: false,
      userId: OWNER,
    } as any);

  const storedFile = (overrides: Record<string, unknown> = {}) => ({
    id: FILE,
    type: 'Model',
    metadata: { fp: 'fp16' },
    modelVersion: { uploadType: 'Created', trainingStatus: null },
    ...overrides,
  });

  beforeEach(() => {
    fileFindMany.mockReset().mockResolvedValue([storedFile()]);
    fileUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    mockDbRead.model.findUniqueOrThrow.mockResolvedValue({
      userId: OWNER,
      modelVersions: [TARGET, SOURCE, OTHER_OF_SAME_MODEL].map((id) => ({
        id,
        name: `v${id}`,
        description: '',
        status: 'Published',
        monetization: null,
        meta: null,
      })),
    });
    mockDbWrite.paidAccess.findMany.mockResolvedValue([]);
    mockDbWrite.$transaction.mockImplementation(async (fn: (client: unknown) => unknown) => fn(tx));
  });

  const inMerge = {
    modelVersionId: { in: [TARGET, SOURCE] },
    modelVersion: { modelId: MODEL, model: { userId: OWNER } },
  };

  it('looks the mapped files up only among the merged versions of the caller’s model', async () => {
    await expect(merge([{ fileId: FILE, type: 'VAE' }])).rejects.toThrow(PAST_REMAP);

    expect(fileFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [FILE] }, ...inMerge } })
    );
  });

  // The lookup above returns nothing for a file outside the merge: another owner's file, or a
  // version of this model that is not being merged.
  it('refuses a file that is not part of the merge, writing nothing', async () => {
    fileFindMany.mockResolvedValue([]);

    await expect(merge([{ fileId: 4242, type: 'VAE', metadata: { fp: 'bf16' } }])).rejects.toThrow(
      'A file to update is not part of this merge.'
    );
    expect(fileUpdateMany).not.toHaveBeenCalled();
  });

  it('writes a remap scoped to the merge, merging the stored metadata', async () => {
    await expect(
      merge([{ fileId: FILE, type: 'VAE', metadata: { size: 'pruned' } }])
    ).rejects.toThrow(PAST_REMAP);

    expect(fileUpdateMany).toHaveBeenCalledWith({
      where: { id: FILE, ...inMerge },
      data: { type: 'VAE', metadata: { fp: 'fp16', size: 'pruned' } },
    });
  });

  // The file can leave the merge between the lookup and the write (moved, deleted).
  it('refuses when the scoped write does not land on exactly that file', async () => {
    fileUpdateMany.mockResolvedValue({ count: 0 });

    await expect(merge([{ fileId: FILE, type: 'VAE' }])).rejects.toThrow(
      'A file to update is not part of this merge.'
    );
  });

  it.each([
    { uploadType: 'Trained', trainingStatus: 'Approved' },
    { uploadType: 'Created', trainingStatus: null },
  ])('refuses turning a file into training data (%o)', async (modelVersion) => {
    fileFindMany.mockResolvedValue([storedFile({ modelVersion })]);

    await expect(merge([{ fileId: FILE, type: 'Training Data' }])).rejects.toThrow(
      "A file can't be changed to training data. Upload the dataset as training data instead."
    );
    expect(fileUpdateMany).not.toHaveBeenCalled();
  });

  it('still applies other type changes on a trained version', async () => {
    fileFindMany.mockResolvedValue([
      storedFile({ modelVersion: { uploadType: 'Trained', trainingStatus: 'Approved' } }),
    ]);

    await expect(merge([{ fileId: FILE, type: 'Pruned Model' }])).rejects.toThrow(PAST_REMAP);
    expect(fileUpdateMany).toHaveBeenCalledWith({
      where: { id: FILE, ...inMerge },
      data: { type: 'Pruned Model' },
    });
  });
});

describe('mergeVersions training runs', () => {
  const OWNER = 7;
  const MODEL = 1;
  const TARGET = 100;
  const SOURCE = 101;

  // Reaching the first write means every check before it passed.
  const PAST_CHECKS = 'reached the file move';
  const versionRows = vi.fn();
  const datasetFindFirst = vi.fn();
  const fileMove = vi.fn(() => {
    throw new Error(PAST_CHECKS);
  });
  const tx = {
    $queryRaw: versionRows,
    modelFile: { findFirst: datasetFindFirst, updateMany: fileMove },
  };

  const row = (id: number, status: string, trainingStatus: string | null) => ({
    id,
    name: `v${id}`,
    status,
    trainingStatus,
  });
  const stored = (
    source: { status?: string; trainingStatus: string | null },
    target: { status?: string; trainingStatus?: string | null } = {}
  ) =>
    versionRows.mockResolvedValue([
      row(TARGET, target.status ?? 'Draft', target.trainingStatus ?? null),
      row(SOURCE, source.status ?? 'Draft', source.trainingStatus),
    ]);

  const merge = () =>
    mergeVersions({
      modelId: MODEL,
      targetVersionId: TARGET,
      sourceVersionIds: [SOURCE],
      appendDescriptions: false,
      userId: OWNER,
    } as any);

  beforeEach(() => {
    versionRows.mockReset();
    datasetFindFirst.mockReset().mockResolvedValue({ modelVersionId: SOURCE });
    fileMove.mockClear();
    mockDbRead.model.findUniqueOrThrow.mockResolvedValue({
      userId: OWNER,
      modelVersions: [TARGET, SOURCE].map((id) => ({
        id,
        name: `v${id}`,
        description: '',
        status: 'Draft',
        monetization: null,
        meta: null,
      })),
    });
    mockDbWrite.paidAccess.findMany.mockResolvedValue([]);
    mockDbWrite.$transaction.mockImplementation(async (fn: (client: unknown) => unknown) => fn(tx));
  });

  it.each(['Submitted', 'Processing', 'Paused', 'Denied'])(
    'refuses a source whose run is %s, moving nothing',
    async (trainingStatus) => {
      stored({ trainingStatus });

      await expect(merge()).rejects.toThrow(
        `Version "v101" has a training run in progress, under review or denied, and can't be merged.`
      );
      expect(fileMove).not.toHaveBeenCalled();
    }
  );

  it.each(['InReview', 'Approved'])(
    'refuses moving a %s source dataset onto a version that takes a new dataset',
    async (trainingStatus) => {
      stored({ trainingStatus }, { status: 'Draft', trainingStatus: null });

      await expect(merge()).rejects.toThrow(
        `Version "v101" has a finished training run, so its training data can't move to a version that still accepts new training data.`
      );
      expect(datasetFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { modelVersionId: { in: [SOURCE] }, type: 'Training Data' },
        })
      );
      expect(fileMove).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['into a published target', { trainingStatus: 'InReview' }, { status: 'Published' }],
    [
      'into a target with its own started run',
      { trainingStatus: 'Approved' },
      { trainingStatus: 'InReview' },
    ],
    ['from a source that never trained', { trainingStatus: null }, {}],
    ['from a source whose run failed', { trainingStatus: 'Failed' }, {}],
  ] as const)('merges %s', async (_, source, target) => {
    stored(source, target);

    await expect(merge()).rejects.toThrow(PAST_CHECKS);
  });

  it('merges a trained source that has no training data', async () => {
    stored({ trainingStatus: 'InReview' });
    datasetFindFirst.mockResolvedValue(null);

    await expect(merge()).rejects.toThrow(PAST_CHECKS);
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
    // No write, so it may only fill a NULL endsAt.
    expect(mockMaterialize).toHaveBeenCalledWith(1, version().publishedAt, mockDbWrite, {
      pendingOnly: true,
    });
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
    expect(mockMaterialize).toHaveBeenCalledWith(1, publishedAt, mockDbWrite, {
      pendingOnly: false,
    });
  });

  it('with a modelId, loads only that model’s versions to publish', async () => {
    mockDbWrite.modelVersion.findMany.mockResolvedValueOnce([]);

    await publishModelVersionsWithEarlyAccess({ modelVersionIds: [1, 9], modelId: 2 });

    expect(mockDbWrite.modelVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 9] }, modelId: 2 } })
    );
    expect(mockDbWrite.modelVersion.update).not.toHaveBeenCalled();
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

  describe('on a published version', () => {
    const published = (gate: { timeframeDays: number | null; endsAt: Date | null } | null) => {
      mockDbRead.modelVersion.findUnique.mockResolvedValueOnce({
        initialPublishedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'Published',
      });
      vi.mocked(getPaidAccess).mockResolvedValueOnce(gate ? { 10: gate } : {});
    };

    it('lets an ended window be resubmitted unchanged, without counting it against the caps', async () => {
      published({ timeframeDays: 7, endsAt: new Date(Date.now() - 86_400_000) });
      mockMaxModels.mockReturnValue(0);
      await expect(
        assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7, versionId: 10 })
      ).resolves.toBeUndefined();
      expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses restarting an ended window with a different length', async () => {
      published({ timeframeDays: 7, endsAt: new Date(Date.now() - 86_400_000) });
      await expect(
        assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 14, versionId: 10 })
      ).rejects.toThrow("Early access can't be started");
    });

    it('refuses starting a window on a version that never had one', async () => {
      published(null);
      await expect(
        assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7, versionId: 10 })
      ).rejects.toThrow("Early access can't be started");
    });

    it('lets a running window be re-saved', async () => {
      published({ timeframeDays: 7, endsAt: new Date(Date.now() + 86_400_000) });
      primeActive([10]);
      await expect(
        assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7, versionId: 10 })
      ).resolves.toBeUndefined();
    });

    it('lets a save that sends no window through', async () => {
      await expect(
        assertUserEarlyAccessLimits({ userId: 1, timeframeDays: undefined, versionId: 10 })
      ).resolves.toBeUndefined();
      expect(mockDbRead.modelVersion.findUnique).not.toHaveBeenCalled();
    });
  });

  it('allows a new version while under the cap', async () => {
    primeActive([10]); // 1 active, cap is 2
    await expect(
      assertUserEarlyAccessLimits({ userId: 1, timeframeDays: 7 })
    ).resolves.toBeUndefined();
  });
});

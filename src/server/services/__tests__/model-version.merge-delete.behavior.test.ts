import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  OTHER,
  OWNER,
  commentsLeft,
  createModelDb,
  failDeletesFrom,
  fileIds,
  fileOf,
  modelOf,
  routeToDb,
  seedModelDb,
  seedReviewThread,
  versionIds,
  versionOf,
} from './model-delete.fixture';

/**
 * Deleting or merging away a model version: the statements that decide what goes run against a
 * Postgres stand-in; the rest of each service is real.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const {
  mockDeleteModelFileObjects,
  mockDeregisterFileLocations,
  mockVersionAirs,
  mockBustAirs,
  mockBustFileAirs,
} = vi.hoisted(() => ({
  mockDeleteModelFileObjects: vi.fn(),
  mockDeregisterFileLocations: vi.fn(),
  mockVersionAirs: vi.fn(),
  mockBustAirs: vi.fn(),
  mockBustFileAirs: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionAccessCache: { bust: vi.fn(), refresh: vi.fn() },
  dataForModelsCache: { bust: vi.fn(), refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/text-scan/submit', () => ({
  scanEntitiesInBackground: vi.fn(),
  scanModelAndRules: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { bust: vi.fn(), refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: vi.fn(),
  getOrchestratorVersionAirs: mockVersionAirs,
  bustOrchestratorAirs: mockBustAirs,
}));
vi.mock('~/server/services/orchestrator/scanned-file-airs', () => ({
  bustVersionScannedFileAirs: mockBustFileAirs,
}));
vi.mock('~/server/services/post.service', () => ({
  addPostImage: vi.fn(),
  createPost: vi.fn(),
  bustCachesForPosts: mockBustCachesForPosts,
}));
const { mockBustPostVersionCache } = vi.hoisted(() => ({ mockBustPostVersionCache: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
  dataForModelsCache: { bust: vi.fn(), refresh: vi.fn() },
  bustMvCache: vi.fn(),
  bustPostVersionCache: mockBustPostVersionCache,
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  writePaidAccessForModelVersion: vi.fn(),
  materializePaidAccessEndsAt: vi.fn(),
  bustPaidAccessCache: vi.fn(),
  paidAccessInputFromLegacyConfig: vi.fn(() => null),
  earlyAccessDonationGoalFromLegacyConfig: vi.fn(() => null),
  earlyAccessConfigFromPaidAccess: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, preventModelVersionLag: vi.fn(), preventReplicationLag: vi.fn() };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteModelFileObjects: mockDeleteModelFileObjects };
});
vi.mock('~/utils/storage-resolver', () => ({
  deregisterFileLocations: mockDeregisterFileLocations,
}));

const { flagImagesOnRestrictedVersions, mockBustCachesForPosts } = vi.hoisted(() => ({
  flagImagesOnRestrictedVersions: vi.fn(async () => ({ flagged: 0, postIds: [] as number[] })),
  mockBustCachesForPosts: vi.fn(async (_postIds: number[]) => undefined),
}));
vi.mock('~/server/services/restricted-images.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  flagImagesOnRestrictedVersions,
}));

import { deleteVersionById, mergeVersions } from '~/server/services/model-version.service';

let db: PGlite;

beforeAll(async () => {
  db = await createModelDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockDeleteModelFileObjects.mockResolvedValue(undefined);
  await seedModelDb(db);
  routeToDb(db);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn(dbMock.dbWrite)) as never);
  dbMock.dbWrite.entityAccess.deleteMany.mockResolvedValue({ count: 0 } as never);
  dbMock.dbWrite.paidAccess.deleteMany.mockResolvedValue({ count: 0 } as never);
});

/** Stubs the reads `deleteVersionById` makes through Prisma for `owner`'s first version. */
function stubVersion(owner: number) {
  const id = versionOf(owner);
  const row = { id, modelId: modelOf(owner), status: 'Published', meta: {} };
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([
    { url: `https://files.example.invalid/${id}`, hashes: [] },
  ] as never);
  dbMock.dbWrite.modelVersion.findFirstOrThrow.mockResolvedValue(row as never);
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue(row as never);
  return id;
}

describe('deleteVersionById', () => {
  it('deletes the version, its files and their stored bytes', async () => {
    const id = stubVersion(OWNER);

    await deleteVersionById({ id, isModerator: false });

    expect(await versionIds(db)).not.toContain(id);
    expect(await fileIds(db)).not.toContain(fileOf(id));
    expect(mockDeleteModelFileObjects).toHaveBeenCalledWith([
      `https://files.example.invalid/${id}`,
    ]);
  });

  it('reports a database error and deletes nothing', async () => {
    const id = stubVersion(OWNER);
    await failDeletesFrom(db, 'ModelVersion');

    for (const isModerator of [false, true]) {
      const error = await deleteVersionById({ id, isModerator }).catch((e: Error) => e);
      expect((error as Error).message).toContain('deadlock detected');
    }
    expect(await versionIds(db)).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  it('reports a version another writer deleted first as not found', async () => {
    const id = stubVersion(OWNER);
    routeToDb(db, async (sql) => {
      if (sql.includes('DELETE FROM "ModelVersion"'))
        await db.query(`DELETE FROM "ModelVersion" WHERE id = $1`, [id]);
    });

    await expect(deleteVersionById({ id, isModerator: true })).rejects.toThrow(
      `No model version with id ${id}`
    );
  });

  it("takes a review's comment thread with the version", async () => {
    const id = stubVersion(OWNER);
    await seedReviewThread(db, { reviewId: 1, versionId: id, reviewer: OWNER, commenter: OTHER });

    await deleteVersionById({ id, isModerator: false });

    expect(await commentsLeft(db)).toEqual([]);
  });
});

const STRAGGLER = 'https://files.example.invalid/straggler';

/** Stubs the model read `mergeVersions` validates against, for `owner`'s three versions. */
function stubModel(owner: number) {
  const ids = [1, 2, 3].map((n) => versionOf(owner, n));
  dbMock.dbRead.model.findUniqueOrThrow.mockResolvedValue({
    userId: owner,
    type: 'LORA',
    modelVersions: ids.map((id) => ({
      id,
      name: `v${id}`,
      description: null,
      status: 'Published',
      monetization: null,
      meta: {},
    })),
  } as never);
  // A file row the move missed: deleted from storage once the merge commits.
  dbMock.dbWrite.modelFile.findMany.mockResolvedValue([{ url: STRAGGLER }] as never);
  return { modelId: modelOf(owner), targetVersionId: ids[0], sourceVersionIds: ids.slice(1) };
}

const merge = (owner: number) =>
  mergeVersions({
    ...stubModel(owner),
    fileTypeMappings: [],
    appendDescriptions: false,
    userId: owner,
  });

describe('mergeVersions', () => {
  it('deletes the merged versions and the files the move missed', async () => {
    const { sourceVersionIds, targetVersionId } = stubModel(OWNER);

    await merge(OWNER);

    const left = await versionIds(db);
    expect(left).toContain(targetVersionId);
    for (const id of sourceVersionIds) expect(left).not.toContain(id);
    expect(mockDeleteModelFileObjects).toHaveBeenCalledWith([STRAGGLER]);
  });

  // The sources are deleted by the time the version bust after the merge runs, so their AIRs are read
  // before it; and a file's pinned AIR names its version, so a moved file stays cached under its
  // source's AIR.
  it("busts the versions' AIRs as read before the merge, and each moved file's pinned AIR under its source", async () => {
    const {
      modelId,
      targetVersionId,
      sourceVersionIds: [a, b],
    } = stubModel(OWNER);
    mockVersionAirs.mockResolvedValueOnce(['urn:air:source']);
    dbMock.dbWrite.modelFile.findMany.mockResolvedValueOnce([
      { id: 501, modelVersionId: a },
      { id: 502, modelVersionId: b },
    ] as never);

    await merge(OWNER);

    // What the orchestrator cached the AIRs under: a wrong one evicts nothing.
    const version = { modelId, baseModel: 'SDXL 1.0', model: { type: 'LORA' } };
    expect(mockBustFileAirs).toHaveBeenCalledWith(a, version, [501]);
    expect(mockBustFileAirs).toHaveBeenCalledWith(b, version, [502]);
    expect(mockBustFileAirs).toHaveBeenCalledWith(targetVersionId, version);
    const [write] = dbMock.dbWrite.$transaction.mock.invocationCallOrder;
    expect(mockVersionAirs).toHaveBeenCalledWith([targetVersionId, a, b]);
    expect(mockVersionAirs.mock.invocationCallOrder[0]).toBeLessThan(write);
    expect(mockBustAirs).toHaveBeenCalledWith(['urn:air:source']);
    expect(mockBustAirs.mock.invocationCallOrder[0]).toBeGreaterThan(write);
  });

  it('forgets which version its re-pointed posts were on', async () => {
    const { sourceVersionIds } = stubModel(OWNER);
    dbMock.dbWrite.post.findMany.mockResolvedValueOnce([{ id: 77 }] as never);

    await merge(OWNER);

    expect(dbMock.dbWrite.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelVersionId: { in: sourceVersionIds } } })
    );
    expect(mockBustPostVersionCache).toHaveBeenCalledWith([77]);
    // Read while the posts are still on the merged-away versions, before they are re-pointed.
    const [read] = dbMock.dbWrite.post.findMany.mock.invocationCallOrder;
    const [moved] = dbMock.dbWrite.post.updateMany.mock.invocationCallOrder;
    expect(read).toBeLessThan(moved);
  });

  // Another writer deletes one source while the merge runs: before its lock, or between the lock
  // and the delete. Either way the merge is not found, and nothing it did commits.
  it.each([
    ['before the lock', 'FOR UPDATE', 'One or more versions to merge no longer exist.'],
    [
      'before the delete',
      'DELETE FROM "ModelVersion"',
      'One or more source versions no longer exist.',
    ],
  ])('reports a source deleted %s as not found', async (_, at, message) => {
    const { sourceVersionIds } = stubModel(OWNER);
    const [gone, kept] = sourceVersionIds;
    let deleted = false;
    routeToDb(db, async (sql) => {
      if (deleted || !sql.includes(at)) return;
      deleted = true;
      await db.query(`DELETE FROM "ModelVersion" WHERE id = $1`, [gone]);
    });

    await expect(merge(OWNER)).rejects.toThrow(message);
    expect(deleted).toBe(true);
    if (at === 'FOR UPDATE') expect(await versionIds(db)).toContain(kept);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  it('merges a source listed twice, as once', async () => {
    const { sourceVersionIds, ...rest } = stubModel(OWNER);
    const twice = [sourceVersionIds[0], sourceVersionIds[0]];

    await mergeVersions({
      ...rest,
      sourceVersionIds: twice,
      fileTypeMappings: [],
      appendDescriptions: false,
      userId: OWNER,
    });

    expect(await versionIds(db)).not.toContain(sourceVersionIds[0]);
  });

  it('reports a database error and deletes nothing', async () => {
    const { sourceVersionIds } = stubModel(OWNER);
    await failDeletesFrom(db, 'ModelVersion');

    const error = await merge(OWNER).catch((e: Error) => e);
    expect((error as Error).message).toContain('deadlock detected');
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
    expect(flagImagesOnRestrictedVersions).not.toHaveBeenCalled();
  });

  it("applies the restricted-base-model rule to the target version, which now holds the sources' images", async () => {
    const { targetVersionId } = stubModel(OWNER);

    await merge(OWNER);

    expect(flagImagesOnRestrictedVersions).toHaveBeenCalledTimes(1);
    expect(flagImagesOnRestrictedVersions).toHaveBeenCalledWith({
      modelVersionIds: [targetVersionId],
    });
  });

  it('refreshes the posts of the images it restricts', async () => {
    stubModel(OWNER);
    flagImagesOnRestrictedVersions.mockResolvedValueOnce({ flagged: 2, postIds: [7, 8] });

    await merge(OWNER);

    expect(mockBustCachesForPosts).toHaveBeenCalledWith([7, 8]);
  });

  it('moves the reviews on its sources to the target', async () => {
    vi.mocked(dbMock.dbWrite.resourceReview.updateMany).mockImplementation((async (args: {
      where: { modelVersionId: { in: number[] } };
      data: { modelVersionId: number };
    }) => ({
      count: (
        await db.query(
          `UPDATE "ResourceReview" SET "modelVersionId" = $1 WHERE "modelVersionId" = ANY($2::int[])`,
          [args.data.modelVersionId, args.where.modelVersionId.in]
        )
      ).affectedRows,
    })) as never);
    const { sourceVersionIds, targetVersionId } = stubModel(OWNER);
    await db.query(
      `INSERT INTO "ResourceReview" (id, "userId", "modelVersionId", "modelId") VALUES (1, $1, $2, $3)`,
      [OTHER, sourceVersionIds[0], modelOf(OWNER)]
    );

    await merge(OWNER);

    const moved = await db.query(`SELECT "modelVersionId" FROM "ResourceReview" WHERE id = 1`);
    expect(moved.rows).toEqual([{ modelVersionId: targetVersionId }]);
  });

  // A reviewer's review of a source version goes when they also reviewed the target.
  it("takes the comment thread of a review it drops as superseded, and keeps the target review's", async () => {
    const { sourceVersionIds, targetVersionId } = stubModel(OWNER);
    await seedReviewThread(db, {
      reviewId: 1,
      versionId: sourceVersionIds[0],
      reviewer: 9,
      commenter: OTHER,
    });
    await seedReviewThread(db, {
      reviewId: 2,
      versionId: targetVersionId,
      reviewer: 9,
      commenter: OWNER,
    });

    await merge(OWNER);

    expect(await commentsLeft(db)).toEqual([{ id: 2, onReview: true }]);
  });
});

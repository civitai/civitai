import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CLEAN,
  MARKED,
  REPORTED,
  createModelHoldDb,
  accessRowsOf,
  commentsLeft,
  dropMarkerView,
  failDeletesFrom,
  FORMER_CLEAN,
  holdOwner,
  ownedBefore,
  realTransactions,
  fileIds,
  fileOf,
  modelOf,
  routeToDb,
  seedModelHoldDb,
  seedReviewThread,
  versionIds,
  versionOf,
} from './model-legal-hold.fixture';

/**
 * Deleting or merging away a model version removes its files' rows and stored bytes, so a held owner's
 * versions are refused. The statements that decide it run against a Postgres stand-in; the rest of
 * each service is real.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockDeleteModelFileObjects, mockDeregisterFileLocations } = vi.hoisted(() => ({
  mockDeleteModelFileObjects: vi.fn(),
  mockDeregisterFileLocations: vi.fn(),
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
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
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

import { LEGAL_HOLD_REFUSAL, OWNER_CONTENT_KEPT } from '~/server/services/legal-hold.service';
import { deleteVersionById, mergeVersions } from '~/server/services/model-version.service';

let db: PGlite;

beforeAll(async () => {
  db = await createModelHoldDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mockDeleteModelFileObjects.mockResolvedValue(undefined);
  await seedModelHoldDb(db);
  routeToDb(db);
  // clearAllMocks keeps implementations, so undo a case's real transaction for the next one.
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
  it('deletes a version whose owner no hold covers, files and all', async () => {
    const id = stubVersion(CLEAN);

    await deleteVersionById({ id, isModerator: false });

    expect(await versionIds(db)).not.toContain(id);
    expect(await fileIds(db)).not.toContain(fileOf(id));
    expect(mockDeleteModelFileObjects).toHaveBeenCalledWith([
      `https://files.example.invalid/${id}`,
    ]);
  });

  it.each([
    ['named on a pending report', REPORTED],
    ['under a hold marker', MARKED],
  ])('keeps a version whose owner is %s, and deletes no bytes', async (_, owner) => {
    const id = stubVersion(owner);

    await expect(deleteVersionById({ id, isModerator: false })).rejects.toThrow(OWNER_CONTENT_KEPT);

    expect(await versionIds(db)).toContain(id);
    expect(await fileIds(db)).toContain(fileOf(id));
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
    expect(mockDeregisterFileLocations).not.toHaveBeenCalled();
  });

  it('keeps a version of a model a held account owned before, and deletes no bytes', async () => {
    const id = stubVersion(CLEAN);
    await ownedBefore(db, CLEAN, REPORTED);

    await expect(deleteVersionById({ id, isModerator: false })).rejects.toThrow(OWNER_CONTENT_KEPT);

    expect(await versionIds(db)).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  it('deletes a version of a model only unheld accounts owned (control)', async () => {
    const id = stubVersion(CLEAN);
    await ownedBefore(db, CLEAN, FORMER_CLEAN);

    await deleteVersionById({ id, isModerator: false });

    expect(await versionIds(db)).not.toContain(id);
  });

  it('rolls back the access rows it removed before the refusal, in a real transaction', async () => {
    realTransactions(db);
    const held = stubVersion(REPORTED);
    await expect(deleteVersionById({ id: held, isModerator: false })).rejects.toThrow(
      OWNER_CONTENT_KEPT
    );
    expect(await accessRowsOf(db)).toContain(held);

    // Positive control: the same transaction commits them away for an owner no hold covers.
    const clean = stubVersion(CLEAN);
    await deleteVersionById({ id: clean, isModerator: false });
    expect(await accessRowsOf(db)).not.toContain(clean);
    expect(await versionIds(db)).not.toContain(clean);
  });

  it('tells a moderator why, and an owner nothing about it', async () => {
    const id = stubVersion(REPORTED);

    await expect(deleteVersionById({ id, isModerator: true })).rejects.toThrow(LEGAL_HOLD_REFUSAL);
    const owner = await deleteVersionById({ id, isModerator: false }).catch((e: Error) => e);
    expect((owner as Error).message).not.toMatch(/legal|hold|investigation|safety/i);
  });

  it('deletes nothing when the hold cannot be read', async () => {
    const id = stubVersion(CLEAN);
    await dropMarkerView(db);

    await expect(deleteVersionById({ id, isModerator: false })).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(await versionIds(db)).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });
});

describe('deleteVersionById on a database error', () => {
  it('reports the error, not a hold, and deletes nothing', async () => {
    const id = stubVersion(CLEAN);
    await failDeletesFrom(db, 'ModelVersion');

    for (const isModerator of [false, true]) {
      const error = await deleteVersionById({ id, isModerator }).catch((e: Error) => e);
      expect((error as Error).message).toContain('deadlock detected');
    }
    expect(await versionIds(db)).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });
});

const STRAGGLER = 'https://files.example.invalid/straggler';

describe('deleteVersionById on a version deleted by someone else', () => {
  it('reports it not found, not held, when it is gone by its delete', async () => {
    const id = stubVersion(CLEAN);
    routeToDb(db, async (sql) => {
      if (sql.includes('DELETE FROM "ModelVersion"'))
        await db.query(`DELETE FROM "ModelVersion" WHERE id = $1`, [id]);
    });

    await expect(deleteVersionById({ id, isModerator: true })).rejects.toThrow(
      `No model version with id ${id}`
    );
  });
});

/** Stubs the model read `mergeVersions` validates against, for `owner`'s three versions. */
function stubModel(owner: number) {
  const ids = [1, 2, 3].map((n) => versionOf(owner, n));
  dbMock.dbRead.model.findUniqueOrThrow.mockResolvedValue({
    userId: owner,
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
  it('deletes the merged versions of an owner no hold covers', async () => {
    const { sourceVersionIds, targetVersionId } = stubModel(CLEAN);

    await merge(CLEAN);

    const left = await versionIds(db);
    expect(left).toContain(targetVersionId);
    for (const id of sourceVersionIds) expect(left).not.toContain(id);
    expect(mockDeleteModelFileObjects).toHaveBeenCalledWith([STRAGGLER]);
  });

  it('forgets which version its re-pointed posts were on', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    dbMock.dbWrite.post.findMany.mockResolvedValueOnce([{ id: 77 }] as never);

    await merge(CLEAN);

    expect(dbMock.dbWrite.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelVersionId: { in: sourceVersionIds } } })
    );
    expect(mockBustPostVersionCache).toHaveBeenCalledWith([77]);
    // Read while the posts are still on the merged-away versions, before they are re-pointed.
    const [read] = dbMock.dbWrite.post.findMany.mock.invocationCallOrder;
    const [moved] = dbMock.dbWrite.post.updateMany.mock.invocationCallOrder;
    expect(read).toBeLessThan(moved);
  });

  it.each([
    ['named on a pending report', REPORTED],
    ['under a hold marker', MARKED],
  ])('keeps every version of an owner %s', async (_, owner) => {
    const { sourceVersionIds } = stubModel(owner);

    await expect(merge(owner)).rejects.toThrow(OWNER_CONTENT_KEPT);

    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  // Another writer deletes one source while the merge runs: before its lock, or between the lock
  // and the delete. Either way the merge is not found rather than held, and nothing it did commits.
  it.each([
    ['before the lock', 'FOR UPDATE', 'One or more versions to merge no longer exist.'],
    [
      'before the delete',
      'DELETE FROM "ModelVersion"',
      'One or more source versions no longer exist.',
    ],
  ])('reports a source deleted %s as not found', async (_, at, message) => {
    const { sourceVersionIds } = stubModel(CLEAN);
    const [gone, kept] = sourceVersionIds;
    let deleted = false;
    routeToDb(db, async (sql) => {
      if (deleted || !sql.includes(at)) return;
      deleted = true;
      await db.query(`DELETE FROM "ModelVersion" WHERE id = $1`, [gone]);
    });

    await expect(merge(CLEAN)).rejects.toThrow(message);
    expect(deleted).toBe(true);
    if (at === 'FOR UPDATE') expect(await versionIds(db)).toContain(kept);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  it('merges a source listed twice, as once', async () => {
    const { sourceVersionIds, ...rest } = stubModel(CLEAN);
    const twice = [sourceVersionIds[0], sourceVersionIds[0]];

    await mergeVersions({
      ...rest,
      sourceVersionIds: twice,
      fileTypeMappings: [],
      appendDescriptions: false,
      userId: CLEAN,
    });

    expect(await versionIds(db)).not.toContain(sourceVersionIds[0]);
  });

  it('reports a database error, not a hold, and deletes nothing', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    await failDeletesFrom(db, 'ModelVersion');

    const error = await merge(CLEAN).catch((e: Error) => e);
    expect((error as Error).message).toContain('deadlock detected');
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
  });

  it('refuses the merge of a model a held account owned before, before the transaction', async () => {
    stubModel(CLEAN);
    await ownedBefore(db, CLEAN, MARKED);

    await expect(merge(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  // The record lands after the check before the transaction, so only the DELETE's own guard sees it.
  it('refuses at the delete when an earlier held owner is recorded after the first check', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    let changed = false;
    routeToDb(db, async (sql) => {
      if (changed || !sql.includes('FOR UPDATE')) return;
      changed = true;
      await ownedBefore(db, CLEAN, REPORTED);
    });

    await expect(merge(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(changed).toBe(true);
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
  });

  it('merges the versions of a model only unheld accounts owned (control)', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    await ownedBefore(db, CLEAN, FORMER_CLEAN);

    await merge(CLEAN);

    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).not.toContain(id);
  });

  it('refuses a held owner before the transaction starts', async () => {
    stubModel(REPORTED);

    await expect(merge(REPORTED)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  // The check before the transaction reads the owner as not held; each case changes that between it
  // and the transaction, so only the guard on the DELETE itself can stop the merge.
  it.each([
    ['a hold that lands after the first check', (d: PGlite) => holdOwner(d, CLEAN)],
    ['a hold that can no longer be read', (d: PGlite) => dropMarkerView(d)],
  ])('refuses on %s, at the delete', async (_, change) => {
    const { sourceVersionIds } = stubModel(CLEAN);
    let changed = false;
    routeToDb(db, async (sql) => {
      if (changed || !sql.includes('FOR UPDATE')) return;
      changed = true;
      await change(db);
    });

    await expect(merge(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(changed).toBe(true);
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
  });

  it('deletes nothing when the hold cannot be read', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    await dropMarkerView(db);

    await expect(merge(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
  });
});

// A review cascades with its version, and its comment threads with it.
describe("a held author's comment on a review the version takes with it", () => {
  it('keeps the comment when the version is deleted', async () => {
    const id = stubVersion(CLEAN);
    await seedReviewThread(db, {
      reviewId: 1,
      versionId: id,
      reviewer: CLEAN,
      commenter: REPORTED,
    });

    await deleteVersionById({ id, isModerator: false });

    expect(await versionIds(db)).not.toContain(id);
    expect(await commentsLeft(db)).toEqual([{ id: 1, onReview: false }]);
  });

  it('takes an unheld comment with the version (control)', async () => {
    const id = stubVersion(CLEAN);
    await seedReviewThread(db, { reviewId: 1, versionId: id, reviewer: CLEAN, commenter: CLEAN });

    await deleteVersionById({ id, isModerator: false });

    expect(await commentsLeft(db)).toEqual([]);
  });

  // A reviewer's review of a source version goes when they also reviewed the target, or another
  // source with a higher review id.
  it.each([
    ['the target', 0],
    ['a later source', 2],
  ])('keeps the comment when a merge drops a review superseded by one on %s', async (_, n) => {
    const { sourceVersionIds, targetVersionId } = stubModel(CLEAN);
    const keeper = n === 0 ? targetVersionId : sourceVersionIds[1];
    await seedReviewThread(db, {
      reviewId: 1,
      versionId: sourceVersionIds[0],
      reviewer: 9,
      // Both legs of the hold: a pending report, and the marker.
      commenter: n === 0 ? REPORTED : MARKED,
    });
    await seedReviewThread(db, { reviewId: 2, versionId: keeper, reviewer: 9, commenter: CLEAN });

    await merge(CLEAN);

    expect(await commentsLeft(db)).toContainEqual({ id: 1, onReview: false });
  });

  it('takes an unheld comment on a superseded review with the merge (control)', async () => {
    const { sourceVersionIds, targetVersionId } = stubModel(CLEAN);
    await seedReviewThread(db, {
      reviewId: 1,
      versionId: sourceVersionIds[0],
      reviewer: 9,
      commenter: CLEAN,
    });
    await seedReviewThread(db, {
      reviewId: 2,
      versionId: targetVersionId,
      reviewer: 9,
      commenter: CLEAN,
    });

    await merge(CLEAN);

    expect((await commentsLeft(db)).map((c) => c.id)).not.toContain(1);
  });
});

describe("a held author's review the version takes with it", () => {
  beforeEach(() => {
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
  });
  const review = (id: number, reviewer: number, versionId: number) =>
    db.query(
      `INSERT INTO "ResourceReview" (id, "userId", "modelVersionId", "modelId") VALUES ($1, $2, $3, $4)`,
      [id, reviewer, versionId, modelOf(CLEAN)]
    );
  const copies = async () =>
    (await db.query(`SELECT id, "userId", "holdReasons" FROM "HeldResourceReview" ORDER BY id`))
      .rows;
  const reviewIds = async () =>
    (await db.query<{ id: number }>(`SELECT id FROM "ResourceReview" ORDER BY id`)).rows.map(
      (r) => r.id
    );

  it('copies a held reviewer’s review of a deleted version, and not an unheld one’s', async () => {
    const id = stubVersion(CLEAN);
    await review(1, REPORTED, id);
    await review(2, FORMER_CLEAN, id);

    await deleteVersionById({ id, isModerator: false });

    expect(await reviewIds()).toEqual([]);
    expect(await copies()).toEqual([{ id: 1, userId: REPORTED, holdReasons: ['report'] }]);
  });

  it.each([
    ['the target', 0, REPORTED, ['report']],
    ['a later source', 2, MARKED, ['hold-marker']],
  ])(
    'copies a held reviewer’s review a merge drops as superseded by one on %s, and not an unheld one’s',
    async (_, n, reviewer, holdReasons) => {
      const { sourceVersionIds, targetVersionId } = stubModel(CLEAN);
      const keeper = n === 0 ? targetVersionId : sourceVersionIds[1];
      await review(1, reviewer, sourceVersionIds[0]);
      await review(2, reviewer, keeper);
      await review(3, FORMER_CLEAN, sourceVersionIds[0]);
      await review(4, FORMER_CLEAN, keeper);

      await merge(CLEAN);

      expect(await reviewIds()).toEqual([2, 4]);
      expect(await copies()).toEqual([{ id: 1, userId: reviewer, holdReasons }]);
    }
  );

  it('moves the reviews on its sources to the target, and copies none', async () => {
    const { sourceVersionIds, targetVersionId } = stubModel(CLEAN);
    await review(1, REPORTED, sourceVersionIds[0]);

    await merge(CLEAN);

    const moved = await db.query(`SELECT "modelVersionId" FROM "ResourceReview" WHERE id = 1`);
    expect(moved.rows).toEqual([{ modelVersionId: targetVersionId }]);
    expect(await copies()).toEqual([]);
  });

  it('copies a held reviewer’s review written on a source version after the re-point', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    routeToDb(db, async (sql) => {
      if (sql.includes('DELETE FROM "ModelVersion"'))
        await review(1, REPORTED, sourceVersionIds[0]).catch(() => undefined);
    });

    await merge(CLEAN);

    expect(await reviewIds()).toEqual([]);
    expect(await copies()).toEqual([{ id: 1, userId: REPORTED, holdReasons: ['report'] }]);
  });
});

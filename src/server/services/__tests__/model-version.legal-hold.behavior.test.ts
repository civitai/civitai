import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CLEAN,
  MARKED,
  REPORTED,
  createModelHoldDb,
  accessRowsOf,
  dropMarkerView,
  failDeletesFrom,
  holdOwner,
  realTransactions,
  fileIds,
  fileOf,
  modelOf,
  routeToDb,
  seedModelHoldDb,
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
vi.mock('~/server/services/model.service', () => ({
  updateModelLastVersionAt: vi.fn(),
  dataForModelsCache: { bust: vi.fn(), refresh: vi.fn() },
  bustMvCache: vi.fn(),
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

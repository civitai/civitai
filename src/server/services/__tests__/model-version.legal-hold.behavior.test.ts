import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CLEAN,
  MARKED,
  REPORTED,
  createModelHoldDb,
  dropMarkerView,
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

const { mockDeleteModelFileObjects } = vi.hoisted(() => ({
  mockDeleteModelFileObjects: vi.fn(),
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
vi.mock('~/utils/storage-resolver', () => ({ deregisterFileLocations: vi.fn() }));

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
    expect(dbMock.dbWrite.paidAccess.deleteMany).toHaveBeenCalled(); // rolled back with the throw
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

  it('deletes nothing when the hold cannot be read', async () => {
    const { sourceVersionIds } = stubModel(CLEAN);
    await dropMarkerView(db);

    await expect(merge(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    const left = await versionIds(db);
    for (const id of sourceVersionIds) expect(left).toContain(id);
  });
});

import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as StorageResolver from '~/utils/storage-resolver';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CLEAN,
  MARKED,
  REPORTED,
  createModelHoldDb,
  dropMarkerView,
  fileIds,
  fileOf,
  routeToDb,
  seedModelHoldDb,
  versionOf,
} from './model-legal-hold.fixture';

/**
 * Deleting a model file, or replacing it with a new upload, removes its row and its stored bytes, so
 * a held owner's file is refused. The statements that decide it run against a Postgres stand-in; the
 * rest of each service is real.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));
const { mockDeleteObject } = vi.hoisted(() => ({
  mockDeleteObject: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObject }));
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  deregisterFileLocationsByFile: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { bust: vi.fn(() => Promise.resolve()) },
}));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  createCachedObject: () => ({ bust: vi.fn(() => Promise.resolve()), fetch: vi.fn() }),
}));

import { LEGAL_HOLD_REFUSAL, OWNER_CONTENT_KEPT } from '~/server/services/legal-hold.service';
import { deleteFile, updateFile } from '~/server/services/model-file.service';

let db: PGlite;

beforeAll(async () => {
  db = await createModelHoldDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await seedModelHoldDb(db);
  // A new upload is taken only on a draft.
  await db.exec(`UPDATE "ModelVersion" SET status = 'Draft'`);
  routeToDb(db);
});

const urlOf = (version: number) => `https://files.example.invalid/${version}`;

describe('deleteFile', () => {
  function stubFile() {
    dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
      type: 'Model',
      modelVersion: { trainingStatus: null, model: { status: 'Published' } },
    } as never);
  }
  const remove = (owner: number, isModerator = false) =>
    deleteFile({ id: fileOf(versionOf(owner)), userId: owner, isModerator });

  it('deletes the file of an owner no hold covers, bytes and all', async () => {
    stubFile();

    await remove(CLEAN);

    expect(await fileIds(db)).not.toContain(fileOf(versionOf(CLEAN)));
    expect(mockDeleteObject).toHaveBeenCalledWith(urlOf(versionOf(CLEAN)));
  });

  it.each([
    ['named on a pending report', REPORTED],
    ['under a hold marker', MARKED],
  ])('keeps the file of an owner %s, and deletes no bytes', async (_, owner) => {
    stubFile();

    await expect(remove(owner)).rejects.toThrow(OWNER_CONTENT_KEPT);

    expect(await fileIds(db)).toContain(fileOf(versionOf(owner)));
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('tells a moderator why', async () => {
    stubFile();

    await expect(remove(REPORTED, true)).rejects.toThrow(LEGAL_HOLD_REFUSAL);
    expect(await fileIds(db)).toContain(fileOf(versionOf(REPORTED)));
  });

  it("does not tell a stranger whether someone else's file is held", async () => {
    stubFile();

    // Owned by REPORTED; the caller is CLEAN. Removed nothing, and says nothing of a hold.
    const result = await deleteFile({ id: fileOf(versionOf(REPORTED)), userId: CLEAN });
    expect(result).toBeUndefined();
    expect(await fileIds(db)).toContain(fileOf(versionOf(REPORTED)));
  });

  it('deletes nothing when the hold cannot be read', async () => {
    stubFile();
    await dropMarkerView(db);

    await expect(remove(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(await fileIds(db)).toContain(fileOf(versionOf(CLEAN)));
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

describe('a new upload replacing a file', () => {
  function stubFile(owner: number) {
    const version = versionOf(owner);
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({
      id: fileOf(version),
      name: 'a.safetensors',
      overrideName: null,
      url: urlOf(version),
      type: 'Model',
      visibility: 'Public',
      metadata: {},
      modelVersionId: version,
      sizeKB: 1,
      modelVersion: {
        modelId: owner * 10,
        baseModel: 'SDXL 1.0',
        status: 'Draft',
        trainingStatus: null,
        uploadType: 'Created',
        model: { type: 'Checkpoint', userId: owner },
      },
    } as never);
    dbMock.dbWrite.modelFile.create.mockResolvedValue({ id: 99_999 } as never);
  }
  const replace = (owner: number, isModerator = false) =>
    updateFile({
      id: fileOf(versionOf(owner)),
      url: 'https://files.example.invalid/new',
      userId: owner,
      isModerator,
    });

  it('replaces the file of an owner no hold covers, and deletes the old bytes', async () => {
    stubFile(CLEAN);

    await replace(CLEAN);

    expect(await fileIds(db)).not.toContain(fileOf(versionOf(CLEAN)));
    expect(mockDeleteObject).toHaveBeenCalledWith(urlOf(versionOf(CLEAN)));
  });

  it.each([
    ['named on a pending report', REPORTED],
    ['under a hold marker', MARKED],
  ])('keeps the file of an owner %s, and creates no replacement', async (_, owner) => {
    stubFile(owner);

    await expect(replace(owner)).rejects.toThrow(OWNER_CONTENT_KEPT);

    expect(await fileIds(db)).toContain(fileOf(versionOf(owner)));
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('tells a moderator why', async () => {
    stubFile(MARKED);

    await expect(replace(MARKED, true)).rejects.toThrow(LEGAL_HOLD_REFUSAL);
  });

  it('replaces nothing when the hold cannot be read', async () => {
    stubFile(CLEAN);
    await dropMarkerView(db);

    await expect(replace(CLEAN)).rejects.toThrow(OWNER_CONTENT_KEPT);
    expect(await fileIds(db)).toContain(fileOf(versionOf(CLEAN)));
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

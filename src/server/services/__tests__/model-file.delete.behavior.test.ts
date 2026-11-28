import type { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as StorageResolver from '~/utils/storage-resolver';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  OWNER,
  createModelDb,
  failDeletesFrom,
  fileIds,
  fileOf,
  routeToDb,
  seedModelDb,
  versionOf,
} from './model-delete.fixture';

/**
 * Deleting a model file, or replacing it with a new upload, removes its row and its stored bytes.
 * The statements that decide it run against a Postgres stand-in; the rest of each service is real.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));
const { mockDeleteObject, mockDeregister } = vi.hoisted(() => ({
  mockDeleteObject: vi.fn(() => Promise.resolve()),
  mockDeregister: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObject }));
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  deregisterFileLocationsByFile: mockDeregister,
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { bust: vi.fn(() => Promise.resolve()) },
}));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: vi.fn(() => Promise.resolve()),
  getOrchestratorVersionAirs: vi.fn(() => Promise.resolve([])),
  bustOrchestratorAirs: vi.fn(() => Promise.resolve()),
  bustOrchestratorScannedFileCache: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  createCachedObject: () => ({ bust: vi.fn(() => Promise.resolve()), fetch: vi.fn() }),
}));

import { deleteFile, updateFile } from '~/server/services/model-file.service';

let db: PGlite;

beforeAll(async () => {
  db = await createModelDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await seedModelDb(db);
  // A new upload is taken only on a draft.
  await db.exec(`UPDATE "ModelVersion" SET status = 'Draft'`);
  routeToDb(db);
});

const urlOf = (version: number) => `https://files.example.invalid/${version}`;

describe('deleteFile', () => {
  beforeEach(() => {
    dbMock.dbWrite.modelFile.findFirst.mockResolvedValue({
      type: 'Model',
      modelVersion: { trainingStatus: null, model: { status: 'Published' } },
    } as never);
  });
  const remove = (isModerator = false) =>
    deleteFile({ id: fileOf(versionOf(OWNER)), userId: OWNER, isModerator });

  it('deletes the file, bytes and all', async () => {
    await remove();

    expect(await fileIds(db)).not.toContain(fileOf(versionOf(OWNER)));
    expect(mockDeleteObject).toHaveBeenCalledWith(urlOf(versionOf(OWNER)));
  });

  it('reports a database error and deletes nothing', async () => {
    await failDeletesFrom(db, 'ModelFile');

    for (const isModerator of [false, true]) {
      const error = await remove(isModerator).catch((e: Error) => e);
      expect((error as Error).message).toContain('deadlock detected');
    }
    expect(await fileIds(db)).toContain(fileOf(versionOf(OWNER)));
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });
});

describe('a new upload replacing a file', () => {
  beforeEach(() => {
    const version = versionOf(OWNER);
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
        modelId: OWNER * 10,
        baseModel: 'SDXL 1.0',
        status: 'Draft',
        trainingStatus: null,
        uploadType: 'Created',
        model: { type: 'Checkpoint', userId: OWNER },
      },
    } as never);
    dbMock.dbWrite.modelFile.create.mockResolvedValue({ id: 990200001 } as never);
  });
  const replace = () =>
    updateFile({
      id: fileOf(versionOf(OWNER)),
      url: 'https://files.example.invalid/new',
      userId: OWNER,
      isModerator: false,
    });

  it('replaces the file and deletes the old bytes', async () => {
    await replace();

    expect(await fileIds(db)).not.toContain(fileOf(versionOf(OWNER)));
    expect(dbMock.dbWrite.modelFile.create).toHaveBeenCalled();
    expect(mockDeleteObject).toHaveBeenCalledWith(urlOf(versionOf(OWNER)));
  });

  it('reports a database error and replaces nothing', async () => {
    await failDeletesFrom(db, 'ModelFile');

    const error = await replace().catch((e: Error) => e);
    expect((error as Error).message).toContain('deadlock detected');
    expect(await fileIds(db)).toContain(fileOf(versionOf(OWNER)));
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
  });
});

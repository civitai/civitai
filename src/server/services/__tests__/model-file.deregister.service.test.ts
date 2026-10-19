import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Verifies deleteFile's post-commit cleanup: deleting ONE file now deregisters
// that file's storage-resolver registry row, keyed on the file id the DELETE
// actually removed. The version-keyed deregistration cannot cover this case —
// the model version survives a single-file delete, so nothing version-keyed ever
// reaches the entry and it outlives the file it describes. Deregistration is
// best-effort: a failure must not fail the (already-committed) file delete, and
// must not disturb the object cleanup or the cache bust beside it.

// One local served both clients. The only entry point is deleteFile
// (model-file.service:247), which is dbWrite throughout - modelFile.findFirst (:257) and
// $queryRaw (:284) - so the read half of the alias was dead.
const mockDbWrite = dbMock.dbWrite;

// model-file.service builds a cached object at import (filesForModelVersionCache).
// Hand back a STABLE stub so the test can assert the cache bust actually fired.
const { mockCacheBust } = vi.hoisted(() => ({ mockCacheBust: vi.fn() }));
vi.mock('~/server/utils/cache-helpers', () => ({
  createCachedObject: () => ({ bust: mockCacheBust, fetch: vi.fn(), lookupFn: undefined }),
  // resourceDataCache, reached through updateFile's cache bust; not exercised here.
  createCachedArray: () => ({ bust: vi.fn(), fetch: vi.fn() }),
}));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));

const { mockDeleteModelFileObject, mockDeregisterFileLocationsByFile } = vi.hoisted(() => ({
  mockDeleteModelFileObject: vi.fn(),
  mockDeregisterFileLocationsByFile: vi.fn(),
}));
// Narrow overrides that keep every other export of these modules real — a
// wholesale factory silently disables the whole suite the day the module grows
// an export something else in this graph imports.
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteModelFileObject: mockDeleteModelFileObject,
}));
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deregisterFileLocationsByFile: mockDeregisterFileLocationsByFile,
}));

import { deleteFile } from '~/server/services/model-file.service';
import { ModelStatus } from '~/shared/utils/prisma/enums';

// Pairwise distinct so a test can never pass by picking up the wrong id.
const FILE_ID = 123;
const VERSION_ID = 4242;
const MODEL_ID = 7;
const USER_ID = 55;
const FILE_URL = 'https://files.example.com/model/7/a.safetensors';

function stubDeletableFile({
  type = 'Model',
  modelStatus = ModelStatus.Published,
  rows = [{ modelVersionId: VERSION_ID, modelId: MODEL_ID, url: FILE_URL }],
  trainingStatus = null,
}: {
  type?: string;
  modelStatus?: ModelStatus;
  rows?: unknown[];
  trainingStatus?: string | null;
} = {}) {
  mockDbWrite.modelFile.findFirst.mockResolvedValue({
    type,
    modelVersion: { trainingStatus, model: { status: modelStatus } },
  });
  mockDbWrite.$queryRaw.mockResolvedValue(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteModelFileObject.mockResolvedValue(undefined);
  mockDeregisterFileLocationsByFile.mockResolvedValue({ deleted: 1 });
});

describe('deleteFile — file_locations deregistration', () => {
  it('deregisters by FILE id, and still deletes the object + busts the version cache', async () => {
    stubDeletableFile();

    const result = await deleteFile({ id: FILE_ID, userId: USER_ID });

    expect(result).toEqual({ modelVersionId: VERSION_ID, modelId: MODEL_ID });
    // Literal expected argument: the id of the file that was deleted, as an array.
    expect(mockDeregisterFileLocationsByFile).toHaveBeenCalledTimes(1);
    expect(mockDeregisterFileLocationsByFile).toHaveBeenCalledWith([FILE_ID]);
    // Pre-existing behaviour must survive the addition.
    expect(mockDeleteModelFileObject).toHaveBeenCalledTimes(1);
    expect(mockDeleteModelFileObject).toHaveBeenCalledWith(FILE_URL);
    expect(mockCacheBust).toHaveBeenCalledWith(VERSION_ID);
  });

  it('keys on the file id, never on the version or model id', async () => {
    stubDeletableFile();

    await deleteFile({ id: FILE_ID, userId: USER_ID });

    const arg = mockDeregisterFileLocationsByFile.mock.calls[0][0];
    expect(arg).toEqual([FILE_ID]);
    expect(arg).not.toContain(VERSION_ID);
    expect(arg).not.toContain(MODEL_ID);
  });

  it('does not fail the file delete when deregistration rejects (best-effort)', async () => {
    stubDeletableFile();
    mockDeregisterFileLocationsByFile.mockRejectedValue(new Error('storage-resolver down'));

    const result = await deleteFile({ id: FILE_ID, userId: USER_ID });

    expect(result).toEqual({ modelVersionId: VERSION_ID, modelId: MODEL_ID });
    expect(mockDeregisterFileLocationsByFile).toHaveBeenCalledWith([FILE_ID]);
    // The object cleanup beside it is unaffected.
    expect(mockDeleteModelFileObject).toHaveBeenCalledWith(FILE_URL);
  });

  it('does not fail the file delete when deregistration resolves null (not configured)', async () => {
    stubDeletableFile();
    mockDeregisterFileLocationsByFile.mockResolvedValue(null);

    const result = await deleteFile({ id: FILE_ID, userId: USER_ID });

    expect(result).toEqual({ modelVersionId: VERSION_ID, modelId: MODEL_ID });
  });

  it('still deregisters when the deleted row carried no url (no object cleanup)', async () => {
    stubDeletableFile({
      rows: [{ modelVersionId: VERSION_ID, modelId: MODEL_ID, url: '' }],
    });

    await deleteFile({ id: FILE_ID, userId: USER_ID });

    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    expect(mockDeregisterFileLocationsByFile).toHaveBeenCalledWith([FILE_ID]);
  });

  it('does not deregister when the DELETE removed nothing', async () => {
    // No RETURNING row = the file was not this user's (or was already gone).
    // Deregistering then would drop a registry row for a file that still exists.
    stubDeletableFile({ rows: [] });

    const result = await deleteFile({ id: FILE_ID, userId: USER_ID });

    expect(result).toBeUndefined();
    expect(mockDeregisterFileLocationsByFile).not.toHaveBeenCalled();
    expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
  });

  it('does NOT await the deregister — a hung resolver must not stall the delete', async () => {
    // 🔴 THE NON-BLOCKING CONTRACT, PINNED. An audit showed that adding `await`
    // in front of deregisterFileLocationsByFile left the whole suite green:
    // every other case resolves its mock immediately, so nothing could tell
    // "fire-and-forget" from "awaited". A future edit could therefore add up to
    // the full request timeout of user-facing latency to EVERY file delete
    // against a hung resolver, with no test objecting.
    //
    // Hold the deregister open and require deleteFile to resolve anyway.
    let release: (() => void) | undefined;
    mockDeregisterFileLocationsByFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ deleted: 1 });
        })
    );
    stubDeletableFile();

    await expect(deleteFile({ id: FILE_ID, userId: USER_ID })).resolves.toBeDefined();

    expect(mockDeregisterFileLocationsByFile).toHaveBeenCalled();
    // NOTE on what this does and does not pin: deleteFile resolving while the
    // deregister is still pending proves it is not awaited UNBOUNDEDLY. A
    // bounded wait (await Promise.race([sleep(50), deregister()])) still passes
    // — that shape was checked and does survive. The unbounded case is the one
    // the design forbids, and the mutant that adds a bare `await` dies here.
    release?.();
  });

  it('does not deregister when the delete is refused before the DELETE runs', async () => {
    // Training data on a still-draft model is refused up front — nothing was
    // removed, so nothing may be deregistered.
    stubDeletableFile({ type: 'Training Data', modelStatus: ModelStatus.Draft });

    await expect(deleteFile({ id: FILE_ID, userId: USER_ID })).rejects.toThrow();

    expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(mockDeregisterFileLocationsByFile).not.toHaveBeenCalled();
  });
});

// The DELETE as Postgres receives it: the tagged template with its nested fragments composed.
const deleteSql = () => {
  const call = mockDbWrite.$queryRaw.mock.calls.at(-1) as unknown as [
    TemplateStringsArray,
    ...Prisma.Sql[]
  ];
  return Prisma.sql(call[0], ...call.slice(1));
};

// Decision (2026-10-18): a dataset under review or denied stays on record; only a moderator may
// remove it.
describe('deleteFile — a dataset under review or denied', () => {
  it.each(['Denied', 'Paused'])(
    'refuses the owner on a %s run, and deletes nothing',
    async (status) => {
      stubDeletableFile({ type: 'Training Data', trainingStatus: status });

      await expect(deleteFile({ id: FILE_ID, userId: USER_ID })).rejects.toThrow(
        "Training data for a training run under review or denied can't be deleted."
      );
      expect(mockDbWrite.$queryRaw).not.toHaveBeenCalled();
      expect(mockDeleteModelFileObject).not.toHaveBeenCalled();
    }
  );

  // The status can change between the check and the DELETE, so the DELETE carries it too; a NULL
  // status must not make the condition NULL and drop the row.
  it("repeats the check inside an owner's DELETE, NULL-safe", async () => {
    stubDeletableFile({ type: 'Training Data', trainingStatus: null });

    await deleteFile({ id: FILE_ID, userId: USER_ID });

    const { sql, values } = deleteSql();
    expect(sql.replace(/\s+/g, ' ')).toContain(
      `AND NOT (mf.type = 'Training Data' AND COALESCE(mv."trainingStatus"::text, '') IN (?,?))`
    );
    expect(values).toEqual([FILE_ID, 'Paused', 'Denied']);
  });

  it("leaves a moderator's DELETE without the check", async () => {
    stubDeletableFile({ type: 'Training Data', trainingStatus: 'Denied' });

    await deleteFile({ id: FILE_ID, userId: USER_ID, isModerator: true });

    expect(deleteSql().sql).not.toContain('COALESCE');
  });

  it('lets a moderator remove it', async () => {
    stubDeletableFile({ type: 'Training Data', trainingStatus: 'Denied' });

    await expect(deleteFile({ id: FILE_ID, userId: USER_ID, isModerator: true })).resolves.toEqual({
      modelVersionId: VERSION_ID,
      modelId: MODEL_ID,
    });
    expect(mockDeleteModelFileObject).toHaveBeenCalledWith(FILE_URL);
  });

  it('still lets the owner delete training data of a run that was not denied', async () => {
    stubDeletableFile({ type: 'Training Data', trainingStatus: 'Failed' });

    await expect(deleteFile({ id: FILE_ID, userId: USER_ID })).resolves.toEqual({
      modelVersionId: VERSION_ID,
      modelId: MODEL_ID,
    });
  });
});

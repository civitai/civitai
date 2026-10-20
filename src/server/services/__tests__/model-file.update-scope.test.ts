import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as StorageResolver from '~/utils/storage-resolver';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `updateFile`'s lookup authorizes the file you may EDIT. It says nothing about a destination
 * version, so honouring a posted `modelVersionId` would attach your file to anyone's model version.
 */

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));

const {
  mockResourceDataBust,
  mockBustOrchestrator,
  mockDeleteObject,
  mockDeregister,
  mockFileListBust,
} = vi.hoisted(() => ({
  mockResourceDataBust: vi.fn(() => Promise.resolve()),
  mockBustOrchestrator: vi.fn(() => Promise.resolve()),
  mockDeleteObject: vi.fn(() => Promise.resolve()),
  mockDeregister: vi.fn(() => Promise.resolve()),
  mockFileListBust: vi.fn(() => Promise.resolve()),
}));
// A new upload deletes the old object in the background; keep that off any real bucket.
vi.mock('~/utils/s3-utils', () => ({ deleteModelFileObject: mockDeleteObject }));
vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  deregisterFileLocationsByFile: mockDeregister,
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { bust: mockResourceDataBust },
}));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: mockBustOrchestrator,
}));
// The version's file list (the only createCachedObject in the service).
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  createCachedObject: () => ({ bust: mockFileListBust, fetch: vi.fn() }),
}));

import { updateFile } from '~/server/services/model-file.service';

const OLD_URL = 'https://example.test/a.safetensors';
const NEW_URL = 'https://example.test/b.safetensors';
const NEW_ID = 77;

// Every carried field differs from its column default ('Model', Public), so a fallback that
// drops the old value reads as a diff rather than passing by coincidence.
const FILE = {
  id: 1,
  name: 'a.safetensors',
  overrideName: 'my-lora',
  url: OLD_URL,
  type: 'Pruned Model',
  visibility: 'Private',
  metadata: { fp: 'fp16', selectedEpochUrl: 'https://orch.test/epoch-1' } as Record<
    string,
    unknown
  >,
  modelVersionId: 10,
  sizeKB: 1,
  modelVersion: {
    modelId: 5,
    baseModel: 'SDXL 1.0',
    status: 'Draft',
    trainingStatus: null as string | null,
    uploadType: 'Trained',
    model: { type: 'LORA', userId: 7 },
  },
};

type VersionState = { status: string; trainingStatus: string | null };

/**
 * The transaction runs on its own client, so a statement that escapes it (on `dbWrite`) is visible.
 * `locked` is the version row the transaction reads under FOR UPDATE; it defaults to the snapshot.
 */
const tx = {
  modelFile: { deleteMany: vi.fn(), create: vi.fn() },
  $queryRaw: vi.fn(),
};
let locked: VersionState;
let linkedRows: { sourceId: number | null }[];

const sqlOf = (call: unknown[]) =>
  (call[0] as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim();

function withFile(
  overrides: Partial<VersionState> & {
    type?: string;
    metadata?: Record<string, unknown>;
    uploadType?: string;
    lockedAs?: Partial<VersionState>;
  } = {}
) {
  const status = overrides.status ?? FILE.modelVersion.status;
  const trainingStatus =
    overrides.trainingStatus !== undefined
      ? overrides.trainingStatus
      : FILE.modelVersion.trainingStatus;
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({
    ...FILE,
    type: overrides.type ?? FILE.type,
    metadata: overrides.metadata ?? FILE.metadata,
    modelVersion: {
      ...FILE.modelVersion,
      status,
      trainingStatus,
      uploadType: overrides.uploadType ?? FILE.modelVersion.uploadType,
    },
  });
  locked = { status, trainingStatus, ...overrides.lockedAs };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps a queued mockRejectedValueOnce; a test that never reaches its bust would
  // otherwise hand that rejection to the next test.
  for (const bust of [mockFileListBust, mockResourceDataBust, mockBustOrchestrator])
    bust.mockReset().mockImplementation(() => Promise.resolve());
  withFile();
  linkedRows = [];
  dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) =>
    fn(tx)
  );
  tx.modelFile.deleteMany.mockResolvedValue({ count: 1 });
  tx.modelFile.create.mockResolvedValue({ id: NEW_ID });
  tx.$queryRaw.mockImplementation(async (...call: unknown[]) =>
    sqlOf(call).includes('FOR UPDATE') ? [locked] : linkedRows
  );
});

const writtenData = () =>
  (dbMock.dbWrite.modelFile.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> })
    .data;
const createdData = () =>
  (tx.modelFile.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data;
const repointCalls = () =>
  tx.$queryRaw.mock.calls.filter((call) => sqlOf(call).includes('UPDATE "RecommendedResource"'));

describe('updateFile', () => {
  it('never writes modelVersionId, so a file cannot be moved onto another version', async () => {
    await updateFile({ id: 1, modelVersionId: 999, userId: 7 });

    expect(writtenData()).not.toHaveProperty('modelVersionId');
  });

  it('still writes the fields an owner may legitimately change', async () => {
    await updateFile({ id: 1, overrideName: 'renamed', userId: 7 });

    expect(writtenData()).toMatchObject({ overrideName: 'renamed' });
  });

  it('edits the same record in place when the url is unchanged', async () => {
    const result = await updateFile({ id: 1, url: OLD_URL, overrideName: 'renamed', userId: 7 });

    expect(writtenData()).toEqual({ url: OLD_URL, overrideName: 'renamed', metadata: undefined });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 1, replacedFileId: undefined });
  });

  it('reports a file replaced since the lookup as not found, rather than a silent success', async () => {
    dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateFile({ id: 1, overrideName: 'renamed', userId: 7 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('scopes the lookup to the caller unless they are a moderator', async () => {
    await updateFile({ id: 1, overrideName: 'x', userId: 7 });
    expect(dbMock.dbWrite.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, modelVersion: { model: { userId: 7 } } },
      })
    );

    dbMock.dbWrite.modelFile.findUnique.mockClear();
    await updateFile({ id: 1, overrideName: 'x', userId: 7, isModerator: true });
    expect(dbMock.dbWrite.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, modelVersion: { model: undefined } },
      })
    );
  });
});

/**
 * Decision (2026-10-18): a new upload behind an existing file is a new file record. The old row is
 * deleted (its hashes go with it) and a fresh, unscanned row takes its place, so nothing recorded
 * about the old object describes the new one. To whoever is about to "simplify" this back into an
 * in-place url update: the new id is the point; do not reuse the old row.
 */
describe('a new upload creates a new file record', () => {
  it('deletes the old record and creates an unscanned one with the new id', async () => {
    const result = await updateFile({ id: 1, url: NEW_URL, sizeKB: 2048, userId: 7 });

    expect(tx.modelFile.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, url: OLD_URL, modelVersion: { model: { userId: 7 } } },
    });
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    // The whole row, so a scan field or old header that leaks across is a diff here, and the
    // omitted name/type/visibility/overrideName must come from the old record.
    expect(createdData()).toEqual({
      name: 'a.safetensors',
      overrideName: 'my-lora',
      url: NEW_URL,
      sizeKB: 2048,
      type: 'Pruned Model',
      visibility: 'Private',
      metadata: {
        fp: 'fp16',
        selectedEpochUrl: 'https://orch.test/epoch-1',
        format: 'SafeTensor',
      },
      modelVersionId: 10,
      rawScanResult: Prisma.JsonNull,
      scannedAt: null,
      scanRequestedAt: null,
      virusScanResult: 'Pending',
      virusScanMessage: null,
      pickleScanResult: 'Pending',
      pickleScanMessage: null,
    });
    expect(result).toMatchObject({ id: NEW_ID, replacedFileId: 1, url: NEW_URL, sizeKB: 2048 });
  });

  it('keeps the old size when the upload does not send one', async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(createdData()).toMatchObject({ sizeKB: 1 });
  });

  it('takes name, type, visibility and metadata from the upload over the old record', async () => {
    await updateFile({
      id: 1,
      url: 'https://example.test/epoch-4.safetensors',
      name: 'epoch-4.safetensors',
      type: 'Model',
      visibility: 'Public',
      overrideName: null,
      metadata: { selectedEpochUrl: 'https://orch.test/epoch-4' },
      userId: 7,
    });

    expect(createdData()).toMatchObject({
      name: 'epoch-4.safetensors',
      type: 'Model',
      overrideName: null,
      visibility: 'Public',
      metadata: { fp: 'fp16', selectedEpochUrl: 'https://orch.test/epoch-4' },
    });
  });

  it('scopes the delete to the caller unless they are a moderator', async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7, isModerator: true });

    expect(tx.modelFile.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, url: OLD_URL, modelVersion: { model: undefined } },
    });
  });

  it('creates nothing when the record was replaced or removed since it was read', async () => {
    tx.modelFile.deleteMany.mockResolvedValue({ count: 0 });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(
      'modified concurrently'
    );
    expect(tx.modelFile.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("leaves the old record's object, registration and caches alone when the swap fails", async () => {
    tx.modelFile.create.mockRejectedValue(new Error('insert failed'));

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow('insert failed');
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeregister).not.toHaveBeenCalled();
    expect(mockFileListBust).not.toHaveBeenCalled();
    expect(mockResourceDataBust).not.toHaveBeenCalled();
  });

  it("removes the old record's object and storage registration after the swap", async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(mockDeleteObject).toHaveBeenCalledWith(OLD_URL);
    expect(mockDeregister).toHaveBeenCalledWith([1]);
  });

  it("refreshes the version's file list, which would otherwise keep listing the old id", async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(mockFileListBust).toHaveBeenCalledWith(10);
  });

  // Generation resolves the version by AIR from these caches, which otherwise keep describing the
  // old file for up to their TTL after the swap.
  it("busts the version's resource caches on a new upload, and only then", async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7 });
    expect(mockResourceDataBust).toHaveBeenCalledWith([10]);
    expect(mockBustOrchestrator).toHaveBeenCalledWith(10);

    mockResourceDataBust.mockClear();
    mockBustOrchestrator.mockClear();
    await updateFile({ id: 1, url: OLD_URL, overrideName: 'renamed', userId: 7 });
    expect(mockResourceDataBust).not.toHaveBeenCalled();
    expect(mockBustOrchestrator).not.toHaveBeenCalled();
  });

  it('still succeeds when a cache bust fails after the swap', async () => {
    mockResourceDataBust.mockRejectedValueOnce(new Error('redis down'));
    mockFileListBust.mockRejectedValueOnce(new Error('redis down'));

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).resolves.toMatchObject({
      id: NEW_ID,
    });
  });
});

/**
 * Decision (2026-10-18): a version that has been published keeps its files. New bytes go in a new
 * version. Applies to moderators too.
 */
describe('a published version keeps its files', () => {
  it.each(['Published', 'Unpublished', 'UnpublishedViolation', 'Scheduled'])(
    'refuses a new upload on a %s version',
    async (status) => {
      withFile({ status });

      await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(
        'This version has been published. Upload the new file as a new version.'
      );
      expect(tx.modelFile.deleteMany).not.toHaveBeenCalled();
      expect(tx.modelFile.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a moderator too', async () => {
    withFile({ status: 'Published' });

    await expect(
      updateFile({ id: 1, url: NEW_URL, userId: 99, isModerator: true })
    ).rejects.toThrow('This version has been published');
  });

  // The lookup is a snapshot; a publish can land between it and the swap.
  it('refuses when the version was published after the lookup', async () => {
    withFile({ status: 'Draft', lockedAs: { status: 'Published' } });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(
      'This version has been published'
    );
    expect(tx.modelFile.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['Draft', 'Training'])('allows a new upload on a %s version', async (status) => {
    withFile({ status });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).resolves.toMatchObject({
      id: NEW_ID,
    });
  });

  it('still allows metadata edits on a published version', async () => {
    withFile({ status: 'Published' });

    await expect(updateFile({ id: 1, overrideName: 'renamed', userId: 7 })).resolves.toMatchObject({
      id: 1,
    });
  });
});

/**
 * Decision (2026-10-18): a dataset is fixed once training has started, so the run's results and its
 * review describe the bytes on record (a running run also writes back to the record by id). A
 * retry after a failed or expired run may upload a new one; a denied dataset is never replaced.
 */
describe('training data once training has started', () => {
  const LOCKED = "Training data can't be changed after training has started";

  it.each(['Submitted', 'Processing', 'Paused', 'InReview', 'Approved', 'Denied'])(
    'refuses a new dataset when training is %s',
    async (trainingStatus) => {
      withFile({ type: 'Training Data', trainingStatus });

      await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(LOCKED);
      expect(tx.modelFile.deleteMany).not.toHaveBeenCalled();
      expect(mockDeleteObject).not.toHaveBeenCalled();
    }
  );

  it('refuses a moderator a new dataset on a denied run too', async () => {
    withFile({ type: 'Training Data', trainingStatus: 'Denied' });

    await expect(
      updateFile({ id: 1, url: NEW_URL, userId: 99, isModerator: true })
    ).rejects.toThrow(LOCKED);
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  // A submit claims the version (Submitted) after reading the dataset; the lock serialises them.
  it('refuses when a training submit claimed the version after the lookup', async () => {
    withFile({
      type: 'Training Data',
      trainingStatus: 'Pending',
      lockedAs: { trainingStatus: 'Submitted' },
    });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(LOCKED);
    expect(tx.modelFile.deleteMany).not.toHaveBeenCalled();
  });

  it('locks the version row before deleting anything', async () => {
    withFile({ type: 'Training Data', trainingStatus: 'Pending' });

    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    const lock = tx.$queryRaw.mock.calls.find((call) => sqlOf(call).includes('FOR UPDATE'));
    expect(lock && sqlOf(lock)).toBe(
      'SELECT status, "trainingStatus" FROM "ModelVersion" WHERE id = ?::int FOR UPDATE'
    );
    expect(lock?.slice(1)).toEqual([10]);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.modelFile.deleteMany.mock.invocationCallOrder[0]
    );
  });

  it.each([null, 'Pending', 'Failed', 'Expired'])(
    'allows a new dataset when training is %s',
    async (trainingStatus) => {
      withFile({ type: 'Training Data', trainingStatus });

      await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).resolves.toMatchObject({
        id: NEW_ID,
      });
    }
  );

  it('does not hold other file types to the training guard', async () => {
    withFile({ type: 'Model', trainingStatus: 'Processing' });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).resolves.toMatchObject({
      id: NEW_ID,
    });
  });
});

// The dataset rules key on a file being training data, so that can never change after creation.
describe('a file type change to or from training data on a trained version', () => {
  const REFUSED = "A file can't be changed to or from training data.";
  const REFUSED_INTO =
    "A file can't be changed to training data. Upload the dataset as training data instead.";

  it('refuses turning a file into training data, with or without a new upload', async () => {
    await expect(updateFile({ id: 1, type: 'Training Data', userId: 7 })).rejects.toThrow(
      REFUSED_INTO
    );
    await expect(
      updateFile({ id: 1, url: NEW_URL, type: 'Training Data', userId: 7 })
    ).rejects.toThrow(REFUSED_INTO);
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    expect(tx.modelFile.create).not.toHaveBeenCalled();
  });

  it('refuses turning training data into another type', async () => {
    withFile({ type: 'Training Data' });

    await expect(updateFile({ id: 1, type: 'Model', userId: 7 })).rejects.toThrow(REFUSED);
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });

  it('still allows other type changes and a training-data edit that keeps its type', async () => {
    await expect(updateFile({ id: 1, type: 'VAE', userId: 7 })).resolves.toMatchObject({ id: 1 });

    withFile({ type: 'Training Data' });
    await expect(
      updateFile({ id: 1, type: 'Training Data', overrideName: 'x', userId: 7 })
    ).resolves.toMatchObject({ id: 1 });
  });

  // `uploadType` is owner-writable; a moderator-set status is not, and the delete lock keys on it.
  it.each(['Denied', 'Paused'])(
    'refuses it on a %s run even when the version claims to be uploaded',
    async (trainingStatus) => {
      withFile({ type: 'Training Data', uploadType: 'Created', trainingStatus });

      await expect(updateFile({ id: 1, type: 'Other', userId: 7 })).rejects.toThrow(REFUSED);
      expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    }
  );

  // Decision (2026-10-18): a dataset is stamped only when it is uploaded as training data, and the
  // training submit reads that stamp, so on an uploaded model too a file becomes training data by
  // upload, never by relabel. Ask before relaxing this for the Files tab.
  it("refuses relabeling an uploaded model's attachment as training data", async () => {
    withFile({ uploadType: 'Created', trainingStatus: null });

    await expect(updateFile({ id: 1, type: 'Training Data', userId: 7 })).rejects.toThrow(
      REFUSED_INTO
    );
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
  });

  it("lets an uploaded model's owner relabel training data as another type", async () => {
    withFile({ type: 'Training Data', uploadType: 'Created', trainingStatus: null });

    await expect(updateFile({ id: 1, type: 'Other', userId: 7 })).resolves.toMatchObject({ id: 1 });
  });
});

// The domain stamp gates which domain a paid training submit may run under; it is the server's.
describe('the upload domain on a new dataset', () => {
  it("stamps the request's domain on training data even when the request omits the type", async () => {
    withFile({ type: 'Training Data', metadata: { uploadDomain: 'red', numImages: 3 } });

    await updateFile({ id: 1, url: NEW_URL, userId: 7, uploadDomain: 'green' });

    expect(createdData()).toMatchObject({
      type: 'Training Data',
      metadata: { uploadDomain: 'green', numImages: 3 },
    });
  });

  it('never carries a domain onto a file that is not training data', async () => {
    await updateFile({
      id: 1,
      url: NEW_URL,
      metadata: { uploadDomain: 'red' },
      userId: 7,
      uploadDomain: 'green',
    });

    expect(createdData().metadata).not.toHaveProperty('uploadDomain');
  });
});

// Other versions can link a file as a component by its id; they follow it to the new record.
describe('linked components', () => {
  it('repoints links to the old record at the new one, and only those', async () => {
    linkedRows = [{ sourceId: 300 }, { sourceId: 301 }, { sourceId: null }];

    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    const [call] = repointCalls();
    expect(sqlOf(call)).toBe(
      'UPDATE "RecommendedResource" SET settings = settings || jsonb_build_object( ' +
        "'fileId', ?::int, 'fileName', ?::text ) " +
        "WHERE \"resourceId\" = ?::int AND settings->>'isLinkedComponent' = 'true' " +
        'AND settings->>\'fileId\' = ? RETURNING "sourceId"'
    );
    // Values bind in order: new id, new name, the linked version, the old id.
    expect(call.slice(1)).toEqual([NEW_ID, 'a.safetensors', 10, '1']);
    expect(mockResourceDataBust).toHaveBeenCalledWith([10, 300, 301]);
  });

  // Linked components in use point at checkpoints, archives and training data too.
  it.each(['Model', 'Training Data', 'Archive'])('repoints for a %s file', async (type) => {
    withFile({ type });

    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(repointCalls()).toHaveLength(1);
  });
});

// The tRPC update passes urlFromClient; server-side callers choose their own url and do not.
describe('a new url from a client', () => {
  it('is refused before anything is swapped when it names no object the caller may attach', async () => {
    await expect(
      updateFile({ id: 1, url: NEW_URL, userId: 7, urlFromClient: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
  });

  it('is not checked when the url is the one the file already has', async () => {
    await expect(
      updateFile({ id: 1, url: OLD_URL, overrideName: 'renamed', userId: 7, urlFromClient: true })
    ).resolves.toMatchObject({ id: 1 });
    expect(dbMock.dbWrite.modelFile.findFirst).not.toHaveBeenCalled();
  });

  it('is not checked for a moderator', async () => {
    await expect(
      updateFile({ id: 1, url: NEW_URL, userId: 99, isModerator: true, urlFromClient: true })
    ).resolves.toMatchObject({ id: NEW_ID });
  });
});

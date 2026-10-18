import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageResolver from '~/utils/storage-resolver';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `updateFile`'s lookup authorizes the file you may EDIT. It says nothing about a destination
 * version, so honouring a posted `modelVersionId` would attach your file to anyone's model version.
 */

vi.mock('~/server/services/model-version.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(() => Promise.resolve()),
}));

const { mockResourceDataBust, mockBustOrchestrator, mockDeleteObject, mockDeregister } = vi.hoisted(
  () => ({
    mockResourceDataBust: vi.fn(() => Promise.resolve()),
    mockBustOrchestrator: vi.fn(() => Promise.resolve()),
    mockDeleteObject: vi.fn(() => Promise.resolve()),
    mockDeregister: vi.fn(() => Promise.resolve()),
  })
);
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

import { updateFile } from '~/server/services/model-file.service';

const OLD_URL = 'https://example.test/a.safetensors';
const NEW_URL = 'https://example.test/b.safetensors';
const NEW_ID = 77;

const FILE = {
  id: 1,
  name: 'a.safetensors',
  overrideName: 'my-lora',
  url: OLD_URL,
  type: 'Model',
  visibility: 'Public',
  metadata: { fp: 'fp16', selectedEpochUrl: 'https://orch.test/epoch-1' },
  modelVersionId: 10,
  sizeKB: 1,
  modelVersion: {
    modelId: 5,
    baseModel: 'SDXL 1.0',
    status: 'Draft',
    trainingStatus: null as string | null,
    model: { type: 'LORA', userId: 7 },
  },
};

function withFile(overrides: {
  type?: string;
  status?: string;
  trainingStatus?: string | null;
  modelType?: string;
}) {
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue({
    ...FILE,
    type: overrides.type ?? FILE.type,
    modelVersion: {
      ...FILE.modelVersion,
      status: overrides.status ?? FILE.modelVersion.status,
      trainingStatus:
        overrides.trainingStatus !== undefined
          ? overrides.trainingStatus
          : FILE.modelVersion.trainingStatus,
      model: { ...FILE.modelVersion.model, type: overrides.modelType ?? 'LORA' },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(FILE);
  dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.modelFile.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.modelFile.create.mockResolvedValue({ id: NEW_ID });
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
});

const writtenData = () =>
  (dbMock.dbWrite.modelFile.updateMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> })
    .data;
const createdData = () =>
  (dbMock.dbWrite.modelFile.create.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> })
    .data;
const repointCalls = () =>
  dbMock.dbWrite.$queryRaw.mock.calls.filter((call) =>
    (call[0] as TemplateStringsArray).join('?').includes('UPDATE "RecommendedResource"')
  );

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
    expect(dbMock.dbWrite.modelFile.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 1, replacedFileId: undefined });
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

    expect(dbMock.dbWrite.modelFile.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, url: OLD_URL, modelVersion: { model: { userId: 7 } } },
    });
    expect(dbMock.dbWrite.modelFile.updateMany).not.toHaveBeenCalled();
    // The whole row, so a scan field or old header that leaks across is a diff here.
    expect(createdData()).toEqual({
      name: 'a.safetensors',
      overrideName: 'my-lora',
      url: NEW_URL,
      sizeKB: 2048,
      type: 'Model',
      visibility: 'Public',
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

  it('takes name, type, visibility and metadata from the upload over the old record', async () => {
    await updateFile({
      id: 1,
      url: 'https://example.test/epoch-4.safetensors',
      name: 'epoch-4.safetensors',
      visibility: 'Private',
      overrideName: null,
      metadata: { selectedEpochUrl: 'https://orch.test/epoch-4' },
      userId: 7,
    });

    expect(createdData()).toMatchObject({
      name: 'epoch-4.safetensors',
      overrideName: null,
      visibility: 'Private',
      metadata: { fp: 'fp16', selectedEpochUrl: 'https://orch.test/epoch-4' },
    });
  });

  it('scopes the delete to the caller unless they are a moderator', async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7, isModerator: true });

    expect(dbMock.dbWrite.modelFile.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, url: OLD_URL, modelVersion: { model: undefined } },
    });
  });

  it('creates nothing when the record was replaced or removed since it was read', async () => {
    dbMock.dbWrite.modelFile.deleteMany.mockResolvedValue({ count: 0 });

    await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(
      'modified concurrently'
    );
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
    expect(mockDeleteObject).not.toHaveBeenCalled();
    expect(mockDeregister).not.toHaveBeenCalled();
  });

  it("removes the old record's object and storage registration after the swap", async () => {
    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(mockDeleteObject).toHaveBeenCalledWith(OLD_URL);
    expect(mockDeregister).toHaveBeenCalledWith([1]);
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

  it('still succeeds when a cache bust fails', async () => {
    mockResourceDataBust.mockRejectedValueOnce(new Error('redis down'));
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
      expect(dbMock.dbWrite.modelFile.deleteMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a moderator too', async () => {
    withFile({ status: 'Published' });

    await expect(
      updateFile({ id: 1, url: NEW_URL, userId: 99, isModerator: true })
    ).rejects.toThrow('This version has been published');
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

// A running training workflow writes its results back to the training-data record by id.
describe('training data while a run is in flight', () => {
  it.each(['Submitted', 'Processing', 'Paused'])(
    'refuses a new dataset while training is %s',
    async (trainingStatus) => {
      withFile({ type: 'Training Data', trainingStatus });

      await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).rejects.toThrow(
        'Training is still running'
      );
      expect(dbMock.dbWrite.modelFile.deleteMany).not.toHaveBeenCalled();
    }
  );

  it.each([null, 'Pending', 'Failed', 'InReview'])(
    'allows a new dataset when training is %s',
    async (trainingStatus) => {
      withFile({ type: 'Training Data', trainingStatus });

      await expect(updateFile({ id: 1, url: NEW_URL, userId: 7 })).resolves.toMatchObject({
        id: NEW_ID,
      });
    }
  );
});

// Other versions can link a file as a component by its id; they follow it to the new record.
describe('linked components', () => {
  it('repoints links to a component file at the new record', async () => {
    withFile({ type: 'Model', modelType: 'VAE' });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ sourceId: 300 }, { sourceId: 301 }]);

    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    const [call] = repointCalls();
    expect(call).toBeDefined();
    // Values bind in order: new id, new name, the linked version, the old id.
    expect(call.slice(1)).toEqual([NEW_ID, 'a.safetensors', 10, '1']);
    expect(mockResourceDataBust).toHaveBeenCalledWith([10, 300, 301]);
  });

  it.each([
    { type: 'Model', modelType: 'LORA' },
    { type: 'Training Data', modelType: 'LORA' },
  ])('skips the link scan for a $modelType $type file', async (file) => {
    withFile(file);

    await updateFile({ id: 1, url: NEW_URL, userId: 7 });

    expect(repointCalls()).toHaveLength(0);
  });
});

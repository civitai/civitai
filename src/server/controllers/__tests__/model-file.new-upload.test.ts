import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';
import type * as StorageResolver from '~/utils/storage-resolver';
import type * as S3Utils from '~/utils/s3-utils';
import { dbMock } from '~/__tests__/mocks/db.mock';
import '~/__tests__/mocks/logging.mock';

/**
 * The epoch picker and the training-data re-upload both send a new url for an existing file through
 * `modelFile.upsert`. These run that payload through the real handler and service, so the endpoint
 * the client calls is the thing pinned.
 */

const {
  mockRegister,
  mockDeregister,
  mockScan,
  mockDeleteObject,
  mockResourceDataBust,
  mockBustOrchestrator,
} = vi.hoisted(() => ({
  mockRegister: vi.fn(() => Promise.resolve()),
  mockDeregister: vi.fn(() => Promise.resolve()),
  mockScan: vi.fn(() => Promise.resolve()),
  mockDeleteObject: vi.fn(() => Promise.resolve()),
  mockResourceDataBust: vi.fn(() => Promise.resolve()),
  mockBustOrchestrator: vi.fn(() => Promise.resolve()),
}));

vi.mock('~/utils/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerFileLocation: mockRegister,
  deregisterFileLocationsByFile: mockDeregister,
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createModelFileScanRequest: mockScan,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  deleteModelFileObject: mockDeleteObject,
}));
vi.mock('~/server/redis/resource-data.redis', () => ({
  resourceDataCache: { bust: mockResourceDataBust },
}));
vi.mock('~/server/services/orchestrator/models', () => ({
  bustOrchestratorModelCache: mockBustOrchestrator,
}));
vi.mock('~/server/db/db-lag-helpers', () => ({
  preventModelVersionLag: vi.fn(() => Promise.resolve()),
}));

import { upsertFileHandler } from '~/server/controllers/model-file.controller';

const OLD_ID = 501;
const NEW_ID = 502;
const VERSION_ID = 4242;
const MODEL_ID = 31;
const OWNER_ID = 7;
const NEW_URL = 'https://bucket.example/modelVersion/4242/epoch_8.safetensors';

const storedFile = (status: string) => ({
  id: OLD_ID,
  name: 'epoch_5.safetensors',
  overrideName: null,
  url: 'https://bucket.example/modelVersion/4242/epoch_5.safetensors',
  type: 'Model',
  visibility: 'Public',
  metadata: { format: 'SafeTensor', selectedEpochUrl: 'https://orch.example/epoch_5' },
  modelVersionId: VERSION_ID,
  sizeKB: 1000,
  modelVersion: {
    modelId: MODEL_ID,
    baseModel: 'SDXL 1.0',
    status,
    trainingStatus: 'Approved',
    model: { type: 'LORA', userId: OWNER_ID },
  },
});

// The payload TrainingSelectFile sends after moveAsset copies the picked epoch.
const epochPick = {
  id: OLD_ID,
  url: NEW_URL,
  name: 'epoch_8.safetensors',
  sizeKB: 2000,
  modelVersionId: VERSION_ID,
  type: 'Model' as const,
  metadata: { format: 'SafeTensor' as const, selectedEpochUrl: 'https://orch.example/epoch_8' },
  backend: 'b2',
  s3Path: 'modelVersion/4242/epoch_8.safetensors',
};

const track = {
  modelFile: vi.fn(() => Promise.resolve()),
  entityChanges: vi.fn(() => Promise.resolve()),
};
const ctx = (isModerator = false) =>
  ({ user: { id: isModerator ? 99 : OWNER_ID, isModerator }, track, domain: 'green' } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelFile.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.modelFile.create.mockResolvedValue({ id: NEW_ID });
});

describe('a new upload through modelFile.upsert', () => {
  it.each([
    { status: 'Published', isModerator: false },
    { status: 'Unpublished', isModerator: false },
    { status: 'Published', isModerator: true },
  ])(
    'refuses the epoch pick on a $status version (moderator: $isModerator)',
    async ({ status, isModerator }) => {
      dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(storedFile(status));

      await expect(upsertFileHandler({ input: epochPick, ctx: ctx(isModerator) })).rejects.toThrow(
        'This version has been published. Upload the new file as a new version.'
      );
      expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockScan).not.toHaveBeenCalled();
    }
  );

  it('on a draft, registers and scans the NEW record, not the old one', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(storedFile('Draft'));

    const result = await upsertFileHandler({ input: epochPick, ctx: ctx() });

    expect(result).toMatchObject({ id: NEW_ID });
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: NEW_ID, path: epochPick.s3Path })
    );
    expect(mockScan).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: NEW_ID,
        modelVersionId: VERSION_ID,
        modelId: MODEL_ID,
        modelType: 'LORA',
        baseModel: 'SDXL 1.0',
        url: NEW_URL,
      })
    );
    expect(mockDeregister).toHaveBeenCalledWith([OLD_ID]);
  });

  it('records that the old record was replaced by the new one', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(storedFile('Draft'));

    await upsertFileHandler({ input: epochPick, ctx: ctx() });

    expect(track.entityChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        entityType: 'ModelFile',
        entityId: OLD_ID,
        ownerId: OWNER_ID,
        field: 'replacedBy',
        newValue: String(NEW_ID),
        actorRole: 'owner',
      }),
    ]);
  });

  it('leaves registration and scanning alone for a metadata-only edit', async () => {
    dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(storedFile('Published'));
    dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });

    const result = await upsertFileHandler({
      input: { id: OLD_ID, overrideName: 'renamed' },
      ctx: ctx(),
    });

    expect(result).toMatchObject({ id: OLD_ID });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
    expect(track.entityChanges).not.toHaveBeenCalled();
  });
});

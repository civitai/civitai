import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';
import type * as StorageResolver from '~/utils/storage-resolver';
import type * as S3Utils from '~/utils/s3-utils';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';
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
const MOD_ID = 99;
const NEW_KEY = 'modelVersion/4242/epoch_8.safetensors';
const NEW_URL = `https://s3.us-west-004.backblazeb2.com/model-bucket/${NEW_KEY}`;

const storedFile = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: OLD_ID,
  name: 'epoch_5.safetensors',
  overrideName: null,
  url: 'https://s3.us-west-004.backblazeb2.com/model-bucket/modelVersion/4242/epoch_5.safetensors',
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
  ...overrides,
});

function givenStored(file: ReturnType<typeof storedFile>) {
  dbMock.dbWrite.modelFile.findUnique.mockResolvedValue(file);
  // The version row the swap locks and re-checks.
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('?').includes('FOR UPDATE')
      ? [{ status: file.modelVersion.status, trainingStatus: file.modelVersion.trainingStatus }]
      : []
  );
}

// The payload TrainingSelectFile sends after moveAsset copies the picked epoch. The s3Path names
// another object on purpose: the registered location must come from the record's url.
const epochPick = {
  id: OLD_ID,
  url: NEW_URL,
  name: 'epoch_8.safetensors',
  sizeKB: 2000,
  modelVersionId: VERSION_ID,
  type: 'Model' as const,
  metadata: { format: 'SafeTensor' as const, selectedEpochUrl: 'https://orch.example/epoch_8' },
  backend: 'b2',
  s3Path: 'someone-else/other.safetensors',
};

const track = {
  modelFile: vi.fn(() => Promise.resolve()),
  entityChanges: vi.fn(() => Promise.resolve()),
};
const ctx = (isModerator = false) =>
  ({
    user: { id: isModerator ? MOD_ID : OWNER_ID, isModerator },
    track,
    domain: 'green',
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  // NEW_URL is a checkpoint copied to the file's own version in an upload bucket.
  envMock.set({ S3_UPLOAD_B2_BUCKET: 'model-bucket' });
  // The guarded raw delete of the old record.
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.modelFile.create.mockResolvedValue({ id: NEW_ID });
  dbMock.dbWrite.modelFile.updateMany.mockResolvedValue({ count: 1 });
});

describe('a new upload through modelFile.upsert', () => {
  it.each([
    { status: 'Published', isModerator: false },
    { status: 'Unpublished', isModerator: false },
    { status: 'Published', isModerator: true },
  ])(
    'refuses the epoch pick on a $status version (moderator: $isModerator)',
    async ({ status, isModerator }) => {
      givenStored(storedFile(status));

      await expect(upsertFileHandler({ input: epochPick, ctx: ctx(isModerator) })).rejects.toThrow(
        'This version has been published. Upload the new file as a new version.'
      );
      expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockScan).not.toHaveBeenCalled();
    }
  );

  it('on a draft, registers and scans the NEW record, at the location its url names', async () => {
    givenStored(storedFile('Draft'));

    const result = await upsertFileHandler({ input: epochPick, ctx: ctx() });

    expect(result).toMatchObject({ id: NEW_ID });
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith({
      fileId: NEW_ID,
      modelVersionId: VERSION_ID,
      modelId: MODEL_ID,
      backend: 'backblaze',
      path: NEW_KEY,
      sizeKb: 2000,
    });
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledWith({
      fileId: NEW_ID,
      modelVersionId: VERSION_ID,
      modelId: MODEL_ID,
      modelType: 'LORA',
      baseModel: 'SDXL 1.0',
      url: NEW_URL,
      preflight: false,
    });
    expect(mockRegister.mock.invocationCallOrder[0]).toBeLessThan(
      mockScan.mock.invocationCallOrder[0]
    );
    expect(mockDeregister).toHaveBeenCalledWith([OLD_ID]);
  });

  it('still answers when the scan submit fails; the fallback job retries it', async () => {
    givenStored(storedFile('Draft'));
    mockScan.mockRejectedValueOnce(new Error('orchestrator down'));

    await expect(upsertFileHandler({ input: epochPick, ctx: ctx() })).resolves.toMatchObject({
      id: NEW_ID,
    });
  });

  it.each([
    { who: 'the owner', isModerator: false, actorRole: 'owner' },
    { who: 'a moderator', isModerator: true, actorRole: 'moderator' },
  ])('records that $who replaced the old record with the new one', async (row) => {
    givenStored(storedFile('Draft'));

    await upsertFileHandler({ input: epochPick, ctx: ctx(row.isModerator) });

    expect(track.entityChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        entityType: 'ModelFile',
        entityId: OLD_ID,
        ownerId: OWNER_ID,
        field: 'replacedBy',
        oldValue: 'null',
        newValue: String(NEW_ID),
        actorRole: row.actorRole,
        reason: 'new-upload',
      }),
    ]);
  });

  it("stamps a training-data upload with the request's domain, not the client's", async () => {
    givenStored(
      storedFile('Draft', {
        type: 'Training Data',
        name: 'data.zip',
        metadata: { uploadDomain: 'red', numImages: 4 },
        // A dataset is replaceable before the first run.
        modelVersion: { ...storedFile('Draft').modelVersion, trainingStatus: null },
      })
    );

    // The dataset re-upload, sent without a type.
    await upsertFileHandler({
      input: {
        id: OLD_ID,
        url: `https://s3.us-west-004.backblazeb2.com/model-bucket/training-images/7/new.zip`,
        sizeKB: 5,
        metadata: { uploadDomain: 'blue' },
      },
      ctx: ctx(),
    });

    const created = dbMock.dbWrite.modelFile.create.mock.calls.at(-1)?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(created.data.metadata).toMatchObject({ uploadDomain: 'green', numImages: 4 });
  });
});

describe('a metadata-only edit through modelFile.upsert', () => {
  it('keeps the record and its registration, whatever storage path the client sends', async () => {
    givenStored(storedFile('Published'));

    const result = await upsertFileHandler({
      input: {
        id: OLD_ID,
        overrideName: 'renamed',
        backend: 'b2',
        s3Path: 'someone-else/other.safetensors',
      },
      ctx: ctx(),
    });

    expect(result).toMatchObject({ id: OLD_ID });
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
    expect(track.entityChanges).not.toHaveBeenCalled();
  });

  // An unstamped dataset is let through as legacy by the paid submit, so a client must not be able
  // to clear the stored stamp by sending an empty one.
  it("keeps a dataset's stored domain when the client sends an empty one", async () => {
    givenStored(
      storedFile('Draft', {
        type: 'Training Data',
        metadata: { uploadDomain: 'red', numImages: 4 },
      })
    );

    await upsertFileHandler({
      input: { id: OLD_ID, metadata: { uploadDomain: null, numImages: 5 } },
      ctx: ctx(),
    });

    const written = dbMock.dbWrite.modelFile.updateMany.mock.calls.at(-1)?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(written.data.metadata).toEqual({ uploadDomain: 'red', numImages: 5 });
  });
});

// A client may only put a url it uploaded (or one already on a model it owns) behind a file.
describe('the url a client sends through modelFile.upsert', () => {
  const OTHER_USERS_URL =
    'https://s3.us-west-004.backblazeb2.com/model-bucket/model/8/theirs.safetensors';

  it('refuses a new url under another user upload prefix before touching the file', async () => {
    givenStored(storedFile('Draft'));

    await expect(
      upsertFileHandler({ input: { ...epochPick, url: OTHER_USERS_URL }, ctx: ctx() })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/upload the file again/i),
    });
    const deletes = dbMock.dbWrite.$executeRaw.mock.calls.filter(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes('DELETE FROM "ModelFile"')
    );
    expect(deletes).toHaveLength(0);
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('lets a moderator put that url behind the file', async () => {
    givenStored(storedFile('Draft'));

    await expect(
      upsertFileHandler({ input: { ...epochPick, url: OTHER_USERS_URL }, ctx: ctx(true) })
    ).resolves.toMatchObject({ id: NEW_ID });
  });

  // A file on a model transferred to its owner keeps the original uploader's key. Resending the url
  // it already has is an edit, not a new upload, and is not checked.
  it('leaves an edit that resends the url the file already has alone', async () => {
    givenStored(storedFile('Draft', { url: OTHER_USERS_URL }));

    await expect(
      upsertFileHandler({
        input: { id: OLD_ID, url: OTHER_USERS_URL, overrideName: 'renamed' },
        ctx: ctx(),
      })
    ).resolves.toMatchObject({ id: OLD_ID });
    expect(dbMock.dbWrite.modelFile.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.modelFile.findFirst).not.toHaveBeenCalled();
  });

  it('refuses the same url on a new file (an upsert without an id)', async () => {
    const { id: _id, ...newFile } = epochPick;

    await expect(
      upsertFileHandler({ input: { ...newFile, url: OTHER_USERS_URL }, ctx: ctx() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.modelFile.create).not.toHaveBeenCalled();
  });
});

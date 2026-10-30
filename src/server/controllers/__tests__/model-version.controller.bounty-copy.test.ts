import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { envMock } from '~/__tests__/mocks/env.mock';

// Harness mirrors model-version.controller.licensing-lineage.test.ts.

const { mockUpsertModelVersion, mockGetModel, mockCreateFile, mockGetFilesByEntity } = vi.hoisted(
  () => ({
    mockUpsertModelVersion: vi.fn(),
    mockGetModel: vi.fn(),
    mockCreateFile: vi.fn(),
    mockGetFilesByEntity: vi.fn(),
  })
);

vi.mock('~/server/services/model-version.service', () => ({
  upsertModelVersion: mockUpsertModelVersion,
  assertUserEarlyAccessLimits: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model.service', () => ({
  getModel: mockGetModel,
  queueModelEarlyAccessReindex: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/model-file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFile: mockCreateFile,
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFilesByEntity: mockGetFilesByEntity,
}));
// Reached at import through the orchestrator caller, which throws without a token.
vi.mock('~/server/services/training.service', () => ({}));
vi.mock('~/server/redis/caches', () => ({ dataForModelsCache: { refresh: vi.fn() } }));

import { upsertModelVersionHandler } from '~/server/controllers/model-version.controller';

const AWARDER = 7;
const AUTHOR = 8;
const BOUNTY = 30;
const ENTRY = 55;
const MODEL = 1;
const VERSION = 100;
const R2 = 'https://acct.r2.example.com';
const R2_BUCKET = 'uploads-r2';

const entryFile = (url: string) => ({
  id: 1,
  name: 'lora.safetensors',
  url,
  sizeKB: 1024,
  metadata: { format: 'SafeTensor' },
  entityId: ENTRY,
});

const createFromBounty = () =>
  upsertModelVersionHandler({
    input: {
      modelId: MODEL,
      name: 'v1.0',
      baseModel: 'SDXL 1.0',
      usageControl: 'Download',
      licensingFee: null,
      bountyId: BOUNTY,
    },
    ctx: {
      user: { id: AWARDER, isModerator: false, meta: {} },
      features: {},
      track: { modelVersionEvent: vi.fn().mockResolvedValue(undefined) },
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  envMock.set({ S3_UPLOAD_ENDPOINT: R2, S3_UPLOAD_BUCKET: R2_BUCKET });
  dbMock.dbWrite.model.findUnique.mockResolvedValue({ type: 'LORA' });
  dbMock.dbRead.bountyEntry.findFirst.mockResolvedValue({
    id: ENTRY,
    userId: AUTHOR,
    bounty: { id: BOUNTY, type: 'LoraCreation' },
  });
  mockGetModel.mockResolvedValue({ nsfw: false, type: 'LORA' });
  mockUpsertModelVersion.mockResolvedValue({ id: VERSION, modelId: MODEL });
  mockCreateFile.mockResolvedValue({ id: 2 });
});

describe('upsertModelVersionHandler — files copied from an awarded bounty entry', () => {
  it("copies the author's own upload in the upload bucket onto the new version", async () => {
    const url = `${R2}/${R2_BUCKET}/default/${AUTHOR}/lora.safetensors`;
    mockGetFilesByEntity.mockResolvedValue([entryFile(url)]);

    await createFromBounty();

    expect(mockCreateFile).toHaveBeenCalledWith(
      expect.objectContaining({
        modelVersionId: VERSION,
        url,
        metadata: expect.objectContaining({ bountyId: BOUNTY, bountyEntryId: ENTRY }),
      })
    );
  });

  it.each([
    ['another user', `${R2}/${R2_BUCKET}/default/9/lora.safetensors`],
    [
      'retired storage',
      `https://s3.us-west-004.backblazeb2.com/retired-2023/default/${AUTHOR}/l.zip`,
    ],
  ])('refuses a file in %s before the version is written', async (_, url) => {
    mockGetFilesByEntity.mockResolvedValue([
      entryFile(`${R2}/${R2_BUCKET}/default/${AUTHOR}/ok.safetensors`),
      entryFile(url),
    ]);

    await expect(createFromBounty()).rejects.toThrowError(/can't be copied into a model version/);
    expect(mockUpsertModelVersion).not.toHaveBeenCalled();
    expect(mockCreateFile).not.toHaveBeenCalled();
  });
});

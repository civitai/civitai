import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// Tests for the file-granular `addLinkedComponent`: link a specific already-uploaded
// file into a version, authorize the referenced file's owner, dedupe per file, and
// optionally remove the redundant local file to reclaim its bytes.

const { mockDbRead, mockDbWrite, mockDeleteFile, mockPreventLag } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  });
  return {
    mockDbRead: { modelFile: mk() },
    mockDbWrite: { recommendedResource: mk(), modelVersion: mk() },
    mockDeleteFile: vi.fn(),
    mockPreventLag: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  preventModelVersionLag: mockPreventLag,
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));
vi.mock('~/server/redis/client', () => ({ REDIS_KEYS: {} }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: {},
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  ingestModelById: vi.fn(),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  filesForModelVersionCache: {},
  deleteFile: mockDeleteFile,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import { addLinkedComponent } from '~/server/services/model-version.service';

const CALLER = 100;

// A file owned by the caller, living on its parent version 777.
const ownFile = {
  id: 555,
  name: 'boogu.vae.safetensors',
  sizeKB: 300_000,
  type: 'VAE',
  metadata: null,
  modelVersionId: 777,
  modelVersion: { model: { userId: CALLER } },
};

const baseInput = {
  id: 10, // edited (source) version
  targetVersionId: 777, // canonical version
  componentType: 'VAE' as const,
  modelId: 20,
  modelName: 'Boogu VAE',
  versionName: 'v1',
  isRequired: true,
  userId: CALLER,
  isModerator: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.recommendedResource.findFirst.mockResolvedValue(null);
  mockDbWrite.recommendedResource.create.mockResolvedValue({ id: 1 });
  mockDbWrite.recommendedResource.update.mockResolvedValue({ id: 1 });
  mockDbWrite.modelVersion.findUnique.mockResolvedValue({ modelId: 99 });
});

describe('addLinkedComponent with targetFileId', () => {
  it('links the explicitly chosen file (not the auto-picked primary)', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    const result = await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockDbRead.modelFile.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 555 } })
    );
    // never falls back to auto-pick when an explicit file is given
    expect(mockDbRead.modelFile.findMany).not.toHaveBeenCalled();

    const createArg = mockDbWrite.recommendedResource.create.mock.calls[0][0];
    expect(createArg.data.settings.fileId).toBe(555);
    // resourceId is taken authoritatively from the file's parent version
    expect(createArg.data.resourceId).toBe(777);
    expect(result.fileId).toBe(555);
  });

  it('rejects with FORBIDDEN when the caller does not own the referenced file', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      ...ownFile,
      modelVersion: { model: { userId: 999 } },
    });

    await expect(addLinkedComponent({ ...baseInput, targetFileId: 555 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('allows a moderator to link a file they do not own', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue({
      ...ownFile,
      modelVersion: { model: { userId: 999 } },
    });

    await addLinkedComponent({ ...baseInput, targetFileId: 555, isModerator: true });

    expect(mockDbWrite.recommendedResource.create).toHaveBeenCalled();
  });

  it('throws NOT_FOUND when the referenced file does not exist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(null);

    await expect(addLinkedComponent({ ...baseInput, targetFileId: 555 })).rejects.toBeInstanceOf(
      TRPCError
    );
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });

  it('dedupes per file id so two files from one version coexist', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    const where = mockDbWrite.recommendedResource.findFirst.mock.calls[0][0].where;
    // the dedupe lookup must constrain on the specific fileId, not just
    // (sourceId, resourceId) — otherwise a second file overwrites the first
    expect(where).toMatchObject({
      sourceId: baseInput.id,
      AND: expect.arrayContaining([{ settings: { path: ['fileId'], equals: 555 } }]),
    });
  });

  it('updates the existing row instead of creating when the same file is already linked', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    mockDbWrite.recommendedResource.findFirst.mockResolvedValue({ id: 7 });

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockDbWrite.recommendedResource.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
    expect(mockDbWrite.recommendedResource.create).not.toHaveBeenCalled();
  });
});

describe('addLinkedComponent with replaceFileId (dedup / byte reclaim)', () => {
  // replaceFileId is a component file living on the edited version (id 10).
  const replaceFile = { id: 888, name: 'old.vae', modelVersionId: 10, type: 'VAE' };

  const findUniqueByFile = (files: Record<number, unknown>) =>
    mockDbRead.modelFile.findUnique.mockImplementation(({ where }: { where: { id: number } }) =>
      Promise.resolve(files[where.id] ?? null)
    );

  it('deletes the redundant local file after the link is created', async () => {
    findUniqueByFile({ 555: ownFile, 888: replaceFile });

    await addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 });

    expect(mockDeleteFile).toHaveBeenCalledWith({ id: 888, userId: CALLER, isModerator: false });
    // link must be created before the redundant file is removed
    const createOrder = mockDbWrite.recommendedResource.create.mock.invocationCallOrder[0];
    const deleteOrder = mockDeleteFile.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);
  });

  it('rejects a replaceFileId that belongs to a different version', async () => {
    findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, modelVersionId: 999 } });

    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('rejects replacing a primary Model file (never delete the version weights)', async () => {
    findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, type: 'Model' } });

    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDeleteFile).not.toHaveBeenCalled();
  });

  it('rejects replacing primary-weights file types beyond Model (Diffusion Model, UNet) + Training Data', async () => {
    for (const type of ['Diffusion Model', 'UNet', 'Training Data']) {
      mockDeleteFile.mockClear();
      findUniqueByFile({ 555: ownFile, 888: { ...replaceFile, type } });
      await expect(
        addLinkedComponent({ ...baseInput, targetFileId: 555, replaceFileId: 888 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(mockDeleteFile).not.toHaveBeenCalled();
    }
  });

  it('rejects a targetVersionId that does not match the targetFileId parent version', async () => {
    // ownFile lives on version 777; a caller-provided targetVersionId of 999 would
    // produce inconsistent denormalized data, so it is rejected.
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);
    await expect(
      addLinkedComponent({ ...baseInput, targetFileId: 555, targetVersionId: 999 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('does not delete anything when replaceFileId is absent', async () => {
    mockDbRead.modelFile.findUnique.mockResolvedValue(ownFile);

    await addLinkedComponent({ ...baseInput, targetFileId: 555 });

    expect(mockDeleteFile).not.toHaveBeenCalled();
  });
});

describe('addLinkedComponent auto-pick (no targetFileId — public path unchanged)', () => {
  it('picks the primary file by modelFileOrder', async () => {
    mockDbRead.modelFile.findMany.mockResolvedValue([
      { id: 2, name: 'extra.vae', sizeKB: 100, type: 'VAE', metadata: null },
      { id: 9, name: 'main.safetensors', sizeKB: 200, type: 'Model', metadata: null },
    ]);

    const result = await addLinkedComponent({ ...baseInput });

    expect(mockDbRead.modelFile.findUnique).not.toHaveBeenCalled();
    const createArg = mockDbWrite.recommendedResource.create.mock.calls[0][0];
    expect(createArg.data.settings.fileId).toBe(9);
    expect(result.fileId).toBe(9);
  });
});


import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verifies deleteVersionById's post-commit cleanup: it deregisters the
// storage-resolver file_locations rows for the deleted version (the go-forward
// fix for leaked tiered objects) WHILE preserving the legacy ModelFile.url S3
// cleanup for non-tiered/legacy files. deregister is best-effort — a failure
// must not fail the (already-committed) version delete.

const { mockDbWrite } = vi.hoisted(() => {
  const mk = () => ({
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });
  const write = {
    modelVersion: mk(),
    modelFile: mk(),
    entityAccess: mk(),
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { mockDbWrite: write };
});

const { mockDeleteModelFileObjects, mockDeregisterFileLocations } = vi.hoisted(() => ({
  mockDeleteModelFileObjects: vi.fn(),
  mockDeregisterFileLocations: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbWrite, dbWrite: mockDbWrite }));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});

// Keep the heavy service/search-index graph out of the test module graph
// (mirrors model-version.idempotent.service.test.ts).
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));
vi.mock('~/server/redis/client', async () => {
  const actual = await vi.importActual<typeof import('@civitai/redis/client')>('@civitai/redis/client');
  return { ...actual, redis: { get: vi.fn(), set: vi.fn() }, sysRedis: { get: vi.fn() } };
});
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
vi.mock('~/server/services/model-file.service', () => ({ filesForModelVersionCache: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, preventModelVersionLag: vi.fn() };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteModelFileObjects: mockDeleteModelFileObjects };
});
vi.mock('~/utils/storage-resolver', () => ({
  deregisterFileLocations: mockDeregisterFileLocations,
}));

import { deleteVersionById } from '~/server/services/model-version.service';

// Drive the interactive transaction: invoke the callback with a `tx` that maps
// to our mocked dbWrite delegates, so the snapshot + cascade run against mocks.
function wireTransaction() {
  mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb(mockDbWrite)
  );
}

const VERSION_ID = 4242;

function stubVersionRows(fileUrls: string[]) {
  mockDbWrite.modelFile.findMany.mockResolvedValue(fileUrls.map((url) => ({ url })));
  mockDbWrite.modelVersion.findFirstOrThrow.mockResolvedValue({
    id: VERSION_ID,
    modelId: 7,
    status: 'Published',
    earlyAccessConfig: null,
    earlyAccessEndsAt: null,
    meta: {},
  });
  mockDbWrite.entityAccess.deleteMany.mockResolvedValue({ count: 0 });
  mockDbWrite.modelVersion.delete.mockResolvedValue({ id: VERSION_ID, modelId: 7 });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireTransaction();
  mockDeleteModelFileObjects.mockResolvedValue(undefined);
  mockDeregisterFileLocations.mockResolvedValue({ deleted: 1 });
});

describe('deleteVersionById — file_locations deregistration', () => {
  it('deregisters by version id AND still runs the legacy ModelFile.url S3 cleanup', async () => {
    stubVersionRows(['https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/a.safetensors']);

    await deleteVersionById({ id: VERSION_ID });

    // Legacy byte cleanup preserved for non-tiered/legacy files.
    expect(mockDeleteModelFileObjects).toHaveBeenCalledTimes(1);
    // The go-forward deregister, keyed on the version id (not per-file url).
    expect(mockDeregisterFileLocations).toHaveBeenCalledTimes(1);
    expect(mockDeregisterFileLocations).toHaveBeenCalledWith(VERSION_ID);
  });

  it('deregisters exactly once regardless of how many files the version has', async () => {
    stubVersionRows([
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/a.safetensors',
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/b.yaml',
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/c.vae',
    ]);

    await deleteVersionById({ id: VERSION_ID });

    expect(mockDeregisterFileLocations).toHaveBeenCalledTimes(1);
    expect(mockDeregisterFileLocations).toHaveBeenCalledWith(VERSION_ID);
    // One batch cleanup call carrying all three urls.
    expect(mockDeleteModelFileObjects).toHaveBeenCalledTimes(1);
    expect(mockDeleteModelFileObjects.mock.calls[0][0]).toHaveLength(3);
  });

  it('still deregisters when the version has no model files (no legacy S3 call)', async () => {
    stubVersionRows([]);

    await deleteVersionById({ id: VERSION_ID });

    // No urls → the legacy cleanup is skipped by the length guard...
    expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
    // ...but deregistration always runs (a never-tiered version is a no-op server-side).
    expect(mockDeregisterFileLocations).toHaveBeenCalledWith(VERSION_ID);
  });

  it('does not fail the version delete if deregistration throws (best-effort)', async () => {
    stubVersionRows(['https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/a.safetensors']);
    mockDeregisterFileLocations.mockRejectedValue(new Error('storage-resolver down'));

    const result = await deleteVersionById({ id: VERSION_ID });

    expect(result).toEqual({ id: VERSION_ID, modelId: 7 });
    expect(mockDeregisterFileLocations).toHaveBeenCalledWith(VERSION_ID);
  });
});

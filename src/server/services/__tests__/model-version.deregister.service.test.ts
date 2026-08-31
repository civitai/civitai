import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Verifies deleteVersionById's post-commit cleanup: it deregisters the
// storage-resolver file_locations rows for the deleted version (the go-forward
// fix for leaked tiered objects) WHILE preserving the legacy ModelFile.url S3
// cleanup for non-tiered/legacy files. deregister is best-effort — a failure
// must not fail the (already-committed) version delete.

// `deleteVersionById` (model-version.service:1047) is dbWrite only — the dbRead spellings
// elsewhere in that module belong to functions this test never calls — so the old alias's read
// half was dead and everything binds to the write client.
const mockDbWrite = dbMock.dbWrite;

const { mockDeleteModelFileObjects, mockDeregisterFileLocations } = vi.hoisted(() => ({
  mockDeleteModelFileObjects: vi.fn(),
  mockDeregisterFileLocations: vi.fn(),
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});

// Keep the heavy service/search-index graph out of the test module graph
// (mirrors model-version.idempotent.service.test.ts).
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
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
  updateModelLastVersionAt: vi.fn(),
}));
// Keep the real paid-access module (which reads REDIS_KEYS.CACHES.PAID_ACCESS at import) out of the graph.
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(async () => ({})),
  writePaidAccessForModelVersion: vi.fn(),
  materializePaidAccessEndsAt: vi.fn(),
  bustPaidAccessCache: vi.fn(),
  paidAccessInputFromLegacyConfig: vi.fn(() => null),
  earlyAccessDonationGoalFromLegacyConfig: vi.fn(() => null),
  earlyAccessConfigFromPaidAccess: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
}));
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

// The old `wireTransaction()` ran the callback against `mockDbWrite` itself — tx and the write
// client were already one object — which is exactly what the canonical `$transaction` default
// does, so it is safe to inherit and the helper is gone.

const VERSION_ID = 4242;

function stubVersionRows(fileUrls: string[]) {
  // The tx snapshot selects `{ url, hashes: { hash } }` (hashes added by #3323 for
  // by-hash edge-cache purge) — mock rows must carry `hashes` or `files.flatMap`
  // dereferences undefined.
  mockDbWrite.modelFile.findMany.mockResolvedValue(fileUrls.map((url) => ({ url, hashes: [] })));
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
  mockDeleteModelFileObjects.mockResolvedValue(undefined);
  mockDeregisterFileLocations.mockResolvedValue({ deleted: 1 });
});

describe('deleteVersionById — file_locations deregistration', () => {
  it('deregisters by version id AND still runs the legacy ModelFile.url S3 cleanup', async () => {
    stubVersionRows([
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/a.safetensors',
    ]);

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
    stubVersionRows([
      'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/model/7/a.safetensors',
    ]);
    mockDeregisterFileLocations.mockRejectedValue(new Error('storage-resolver down'));

    const result = await deleteVersionById({ id: VERSION_ID });

    expect(result).toEqual({ id: VERSION_ID, modelId: 7 });
    expect(mockDeregisterFileLocations).toHaveBeenCalledWith(VERSION_ID);
  });
});

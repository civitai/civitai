import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Mock scaffold mirrors model-version.deregister.service.test.ts.

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

const VERSION_ID = 4242;

function stubVersion(trainingStatus: string | null) {
  mockDbWrite.$queryRaw.mockResolvedValue([{ trainingStatus }] as never);
  mockDbWrite.modelFile.findMany.mockResolvedValue([
    {
      url: 'https://s3.us-west-004.backblazeb2.com/civitai-modelfiles/default/7/data.zip',
      hashes: [],
    },
  ]);
  mockDbWrite.modelVersion.findFirstOrThrow.mockResolvedValue({
    id: VERSION_ID,
    modelId: 7,
    status: 'Draft',
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

describe('deleteVersionById — training run lock', () => {
  it.each(['Submitted', 'Processing', 'Paused', 'Denied'])(
    'refuses an owner deleting a version whose run is %s, removing nothing',
    async (trainingStatus) => {
      stubVersion(trainingStatus);

      await expect(deleteVersionById({ id: VERSION_ID, isModerator: false })).rejects.toThrow(
        "This version's training run is in progress, under review or denied, so it can't be deleted."
      );
      expect(mockDbWrite.modelVersion.delete).not.toHaveBeenCalled();
      expect(mockDeleteModelFileObjects).not.toHaveBeenCalled();
    }
  );

  it.each([null, 'Pending', 'InReview', 'Approved', 'Failed', 'Expired'])(
    'lets an owner delete a version whose run is %s',
    async (trainingStatus) => {
      stubVersion(trainingStatus);

      await deleteVersionById({ id: VERSION_ID, isModerator: false });

      expect(mockDbWrite.modelVersion.delete).toHaveBeenCalledWith({ where: { id: VERSION_ID } });
    }
  );

  it('lets a moderator delete a denied version', async () => {
    stubVersion('Denied');

    await deleteVersionById({ id: VERSION_ID, isModerator: true });

    expect(mockDbWrite.modelVersion.delete).toHaveBeenCalledWith({ where: { id: VERSION_ID } });
  });
});

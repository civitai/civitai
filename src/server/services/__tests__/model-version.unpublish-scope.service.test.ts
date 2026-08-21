import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * `resolveUnpublishScope` decides whether unpublishing one version takes the whole model down. Both
 * the confirm dialog and the mutation call it, so what a creator consents to and what the server
 * does come from one answer — and it reads the PRIMARY, because deciding a take-down against a
 * lagged replica either drops a model whose sibling has just gone live, or leaves a model published
 * with nothing published under it.
 */

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/paid-access.service', () => ({
  materializePaidAccessEndsAt: vi.fn(),
  writePaidAccessForModelVersion: vi.fn(),
  getPaidAccess: vi.fn(),
  assertPaidAccessInput: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedLinkDomain: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  getMultiAccountTransactionsByPrefix: vi.fn(),
  getUserBuzzAccountByAccountTypes: vi.fn(),
  refundMultiAccountTransaction: vi.fn(),
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({
  checkDonationGoalComplete: vi.fn(),
  ensureDonationGoal: vi.fn(),
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({
  ingestModelById: vi.fn().mockResolvedValue(undefined),
  updateModelLastVersionAt: vi.fn(),
}));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
}));
vi.mock('~/server/services/monetization-rights.service', () => ({
  resolveRightsAffirmation: vi.fn(),
}));

import { resolveUnpublishScope } from '~/server/services/model-version.service';

const VERSION_ID = 100;
const MODEL_ID = 42;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
    modelId: MODEL_ID,
    status: 'Published',
  });
});

describe('resolveUnpublishScope', () => {
  it('cascades to the model when no other published version remains', async () => {
    dbMock.dbWrite.modelVersion.count.mockResolvedValue(0);

    await expect(resolveUnpublishScope(VERSION_ID)).resolves.toEqual({
      kind: 'model',
      modelId: MODEL_ID,
    });
  });

  // Negative control: a resolver that always cascaded would take a twelve-version model down over
  // one retired version, and would satisfy the assertion above.
  it('stays version-scoped while another published version remains', async () => {
    dbMock.dbWrite.modelVersion.count.mockResolvedValue(1);

    await expect(resolveUnpublishScope(VERSION_ID)).resolves.toEqual({
      kind: 'version',
      modelId: MODEL_ID,
    });
  });

  it('counts a Scheduled sibling as live, so a pending release is never taken down', async () => {
    dbMock.dbWrite.modelVersion.count.mockResolvedValue(0);

    await resolveUnpublishScope(VERSION_ID);

    // unpublishModelById takes Published AND Scheduled versions down, so counting only Published
    // would cascade past a pending release and unpublish tomorrow's launch on a confirm whose copy
    // said "this is the only published version".
    expect(dbMock.dbWrite.modelVersion.count).toHaveBeenCalledWith({
      where: {
        modelId: MODEL_ID,
        status: { in: ['Published', 'Scheduled'] },
        id: { not: VERSION_ID },
      },
    });
  });

  it('never cascades off a version that is not itself published', async () => {
    // Otherwise saving a draft on a model with nothing published runs a full model unpublish.
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({
      modelId: MODEL_ID,
      status: 'Draft',
    });
    dbMock.dbWrite.modelVersion.count.mockResolvedValue(0);

    await expect(resolveUnpublishScope(VERSION_ID)).resolves.toEqual({
      kind: 'version',
      modelId: MODEL_ID,
    });
    // And it does not even ask — the count is what a replica read would have raced on.
    expect(dbMock.dbWrite.modelVersion.count).not.toHaveBeenCalled();
  });

  it('decides on the primary, never the replica', async () => {
    dbMock.dbWrite.modelVersion.count.mockResolvedValue(0);

    await resolveUnpublishScope(VERSION_ID);

    // Replica lag here either takes down a model whose sibling has just been published, or leaves
    // the empty published model this cascade exists to prevent.
    expect(dbMock.dbRead.modelVersion.count).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

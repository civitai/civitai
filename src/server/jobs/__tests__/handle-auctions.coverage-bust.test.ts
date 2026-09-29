import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ResourceData from '~/server/redis/resource-data.redis';
import type * as OrchestratorModels from '~/server/services/orchestrator/models';

const { bustResourceData, bustOrchestrator, getTopWeeklyEarners } = vi.hoisted(() => ({
  bustResourceData: vi.fn(async () => undefined),
  bustOrchestrator: vi.fn(async () => undefined),
  getTopWeeklyEarners: vi.fn(async () => [] as { modelId: number; modelVersionId: number }[]),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: unknown) => ({ name, cron, run: fn }),
  getJobDate: vi.fn(),
}));
vi.mock('~/server/redis/resource-data.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof ResourceData>()),
  resourceDataCache: { bust: bustResourceData },
}));
vi.mock('~/server/services/orchestrator/models', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorModels>()),
  bustOrchestratorModelCache: bustOrchestrator,
}));
// Heavy import surfaces this path only touches through the functions stubbed here.
vi.mock('~/server/services/model.service', () => ({
  bustFeaturedModelsCache: vi.fn(async () => undefined),
  getTopWeeklyEarners,
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { updateSync: vi.fn() } }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/auction.service', () => ({}));
vi.mock('~/server/services/buzz.service', () => ({}));

import { _handleWinnersForAuction } from '~/server/jobs/handle-auctions';

type AuctionRow = Parameters<typeof _handleWinnersForAuction>[0];
type Winners = Parameters<typeof _handleWinnersForAuction>[1];

const checkpointAuction = {
  auctionBase: { type: 'Model', ecosystem: null },
  validFrom: new Date('2026-09-24'),
  validTo: new Date('2026-10-01'),
} as unknown as AuctionRow;

const winners = [
  { entityId: 11, position: 1, userIds: [1], auctionId: 5 },
  { entityId: 12, position: 2, userIds: [2], auctionId: 5 },
] as unknown as Winners;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.featuredModelVersion.createMany.mockResolvedValue({ count: 2 });
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  getTopWeeklyEarners.mockResolvedValue([{ modelId: 90, modelVersionId: 91 }]);
});

describe('_handleWinnersForAuction — checkpoint coverage', () => {
  it('invalidates the versions that left the covered set along with the winners', async () => {
    dbMock.dbWrite.$transaction.mockResolvedValue([1, [{ version_id: 7 }]]);

    await expect(_handleWinnersForAuction(checkpointAuction, winners)).resolves.toBe(true);

    expect(bustResourceData).toHaveBeenCalledTimes(1);
    expect(bustResourceData).toHaveBeenCalledWith([11, 12, 7]);
    expect(bustOrchestrator).toHaveBeenCalledTimes(1);
    expect(bustOrchestrator).toHaveBeenCalledWith([11, 12, 7]);
  });

  it('reports failure and invalidates nothing when the coverage write fails', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValue(new Error('deadlock'));

    await expect(_handleWinnersForAuction(checkpointAuction, winners)).resolves.toBe(false);

    expect(bustResourceData).not.toHaveBeenCalled();
    expect(bustOrchestrator).not.toHaveBeenCalled();
  });
});

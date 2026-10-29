import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, getConfig } = vi.hoisted(() => ({ query: vi.fn(), getConfig: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: query } }));
vi.mock('~/server/games/new-order/utils', () => ({ getVotingRateLimitConfig: getConfig }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { runLinkDetection } from '~/server/games/new-order/link-detection.service';

const write = dbMock.dbWrite;
const config = {
  lookbackDays: 7,
  maxEarners: 100,
  maxTipRows: 1000,
  ipMaxAccounts: 5,
  ipMinShared: 2,
  sinkMinShare: 0.5,
  sinkMinTips: 3,
  burstSeconds: 60,
  burstMinTips: 3,
  createdGapSeconds: 60,
  createdMinAccounts: 3,
  weights: { ip: 1, sink: 1, burst: 1, created: 1 },
  blockScore: 3,
  reviewScore: 2,
};

describe('runLinkDetection recording the run for Knights', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ linkDetection: config });
    query.mockResolvedValue([]);
    dbMock.dbRead.newOrderPlayer.findMany.mockResolvedValue([]);
  });

  it('records a finished run', async () => {
    await runLinkDetection();

    expect(write.knightsDetectionRun.create).toHaveBeenCalledTimes(1);
  });

  it('dates the run from before its reads, so gold earned while it ran is not released by it', async () => {
    let firstReadAt = Infinity;
    query.mockImplementation(async () => {
      firstReadAt = Math.min(firstReadAt, Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [];
    });

    await runLinkDetection();

    const { completedAt } = write.knightsDetectionRun.create.mock.calls[0][0].data;
    expect(completedAt).toBeInstanceOf(Date);
    expect(completedAt.getTime()).toBeLessThanOrEqual(firstReadAt);
  });

  it('records nothing when detection is not configured, so nothing is released', async () => {
    getConfig.mockResolvedValue(null);

    expect(await runLinkDetection()).toBeNull();
    expect(write.knightsDetectionRun.create).not.toHaveBeenCalled();
  });

  it('records nothing when the run fails', async () => {
    query.mockRejectedValue(new Error('clickhouse down'));

    await expect(runLinkDetection()).rejects.toThrow('clickhouse down');
    expect(write.knightsDetectionRun.create).not.toHaveBeenCalled();
  });
});

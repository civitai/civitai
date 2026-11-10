import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: query } }));
vi.mock('~/server/games/new-order/utils', () => ({ getVotingRateLimitConfig: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { LinkDetectionConfig } from '~/server/games/new-order/link-detection';
import { findLinkedClusters } from '~/server/games/new-order/link-detection.service';

const config: LinkDetectionConfig = {
  lookbackDays: 1,
  maxEarners: 100,
  maxTipRows: 2,
  ipMaxAccounts: 3,
  ipMinShared: 2,
  sinkMinShare: 0.5,
  sinkMinTips: 2,
  burstSeconds: 10,
  burstMinTips: 3,
  createdGapSeconds: 60,
  createdMinAccounts: 2,
  weights: { ip: 3, sink: 2, burst: 4, created: 8 },
  blockScore: 10,
  reviewScore: 2,
};

const tipQuery = () =>
  query.mock.calls.map(([sql]) => String(sql)).find((s) => /FROM buzzTransactions/.test(s));

describe('findLinkedClusters tip loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.newOrderPlayer.findMany.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
    dbMock.dbRead.user.findMany.mockResolvedValue([]);
    query.mockImplementation(async (sql: string) => {
      if (/FROM knights_new_order_image_rating/.test(sql)) return [{ userId: 1 }, { userId: 2 }];
      if (/FROM buzzTransactions/.test(sql)) {
        return [
          { fromAccountId: 1, toAccountId: 9, amount: 5, at: 100 },
          { fromAccountId: 2, toAccountId: 9, amount: 5, at: 90 },
        ];
      }
      return [];
    });
  });

  it('reads the newest tips first so a capped read is the same on every run', async () => {
    await findLinkedClusters(config);

    expect(tipQuery()).toMatch(/ORDER BY date DESC, [\w, ]+\s+LIMIT 2/);
  });

  it('reports when the tip read reached its cap', async () => {
    await findLinkedClusters(config);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-detection-tip-cap' })
    );
  });

  it('stays quiet when the tip read is under its cap', async () => {
    await findLinkedClusters({ ...config, maxTipRows: 3 });

    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

describe('findLinkedClusters earner loading', () => {
  const ipQuery = () =>
    query.mock.calls.map(([sql]) => String(sql)).find((s) => /FROM default.userActivities/.test(s));
  const earnersIn = () => {
    const m = ipQuery()?.match(/targetUserId IN \(([\d,]+)\)/);
    if (!m) throw new Error('no IP query was issued');
    return m[1].split(',').map(Number);
  };
  const mockV1 = (ids: number[]) =>
    query.mockImplementation(async (sql: string) => {
      if (/FROM knights_new_order_image_rating/.test(sql)) return ids.map((userId) => ({ userId }));
      return [];
    });

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.user.findMany.mockResolvedValue([]);
    dbMock.dbRead.newOrderPlayer.findMany.mockImplementation(async ({ where }) =>
      where.userId.in.map((userId: number) => ({ userId }))
    );
  });

  it('returns v2 earners when v1 has none', async () => {
    mockV1([]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }, { playerId: 6 }]);

    await findLinkedClusters(config);

    expect(earnersIn()).toEqual([5, 6]);
  });

  it('merges v2 and v1 earners without duplicates', async () => {
    mockV1([1, 2, 5]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }, { playerId: 6 }]);

    await findLinkedClusters(config);

    expect(earnersIn().sort()).toEqual([1, 2, 5, 6]);
  });

  it('caps the merged list, keeping v2 earners first', async () => {
    mockV1([1, 2, 3]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }, { playerId: 6 }]);

    await findLinkedClusters({ ...config, maxEarners: 3 });

    expect(earnersIn()).toEqual([5, 6, 1]);
  });

  it('still returns v2 earners when the v1 query throws, and logs the failure', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM knights_new_order_image_rating/.test(sql)) throw new Error('clickhouse down');
      return [];
    });
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }, { playerId: 6 }]);

    await findLinkedClusters(config);

    expect(earnersIn()).toEqual([5, 6]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-detection-v1-earners' })
    );
  });

  it('still returns v1 earners when the v2 query throws, and logs the failure', async () => {
    mockV1([1, 2]);
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('relation does not exist'));

    await findLinkedClusters(config);

    expect(earnersIn()).toEqual([1, 2]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-detection-v2-earners' })
    );
  });

  it('throws when both earner sources fail', async () => {
    query.mockRejectedValue(new Error('clickhouse down'));
    dbMock.dbRead.$queryRaw.mockRejectedValue(new Error('relation does not exist'));

    await expect(findLinkedClusters(config)).rejects.toThrow();
  });

  it('warns when the cap drops v1 earners', async () => {
    mockV1([1, 2, 3]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }, { playerId: 6 }]);

    await findLinkedClusters({ ...config, maxEarners: 3 });

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new-order-link-detection-earner-cap',
        details: { v2: 2, v1: 3, dropped: 2 },
      })
    );
  });

  it('stays quiet about the cap when nothing is dropped', async () => {
    mockV1([1, 2]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ playerId: 5 }]);

    await findLinkedClusters(config);

    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-detection-earner-cap' })
    );
  });
});

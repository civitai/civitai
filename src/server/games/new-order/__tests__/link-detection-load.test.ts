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

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { $query: vi.fn() } }));
vi.mock('~/server/games/new-order/utils', () => ({ getVotingRateLimitConfig: vi.fn() }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { LinkCluster } from '~/server/games/new-order/link-detection';
import {
  AUTO_BLOCK_REASON,
  persistLinkedClusters,
} from '~/server/games/new-order/link-detection.service';

const cluster = (userIds: number[], decision: LinkCluster['decision']): LinkCluster => ({
  userIds,
  decision,
  score: 1,
  buzzMoved: 250.4,
  evidence: { sinks: [], ipLinks: [], createdTogether: [] },
});

const write = dbMock.dbWrite;
const reviewWrites = () => write.$queryRaw.mock.calls.map(([, ...values]) => values);

describe('persistLinkedClusters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.newOrderLinkReview.findMany.mockResolvedValue([]);
    write.$queryRaw.mockResolvedValue([{ id: 1 }]);
  });

  it('blocks payouts and records the review for a block decision', async () => {
    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts).toEqual({ blocked: 1, queued: 0, skipped: 0 });
    expect(write.newOrderPlayer.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: [1, 2, 3] }, payoutBlockedAt: null },
      data: expect.objectContaining({ payoutBlockReason: AUTO_BLOCK_REASON, payoutBlockedBy: -1 }),
    });
    const [values] = reviewWrites();
    expect(values).toEqual(expect.arrayContaining(['Blocked', true, 250]));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-auto-block' })
    );
  });

  it('writes the review before the holds, in one transaction', async () => {
    await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(write.$transaction).toHaveBeenCalledTimes(1);
    expect(write.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      write.newOrderPlayer.updateMany.mock.invocationCallOrder[0]
    );
  });

  it('places no hold when the review row cannot be written', async () => {
    write.$queryRaw.mockRejectedValue(new Error('write failed'));

    await expect(persistLinkedClusters([cluster([1, 2, 3], 'block')])).rejects.toThrow(
      'write failed'
    );
    expect(write.newOrderPlayer.updateMany).not.toHaveBeenCalled();
  });

  it('queues a review decision without touching payouts', async () => {
    const counts = await persistLinkedClusters([cluster([1, 2], 'review')]);

    expect(counts).toEqual({ blocked: 0, queued: 1, skipped: 0 });
    expect(write.newOrderPlayer.updateMany).not.toHaveBeenCalled();
    expect(reviewWrites()[0]).toEqual(expect.arrayContaining(['Pending', false]));
  });

  it('downgrades a block to review when a member was cleared by a moderator before', async () => {
    dbMock.dbRead.newOrderLinkReview.findMany.mockResolvedValue([
      { fingerprint: 'other', userIds: [2, 9] },
    ]);

    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts.queued).toBe(1);
    expect(write.newOrderPlayer.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a review a moderator already decided alone', async () => {
    write.$queryRaw.mockResolvedValue([]);

    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts).toEqual({ blocked: 0, queued: 0, skipped: 1 });
    expect(write.newOrderPlayer.updateMany).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});

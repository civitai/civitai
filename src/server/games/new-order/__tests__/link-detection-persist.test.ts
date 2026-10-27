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

const upserts = () => dbMock.dbWrite.newOrderLinkReview.upsert.mock.calls.map(([a]) => a);

describe('persistLinkedClusters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.newOrderLinkReview.findMany.mockResolvedValue([]);
    dbMock.dbWrite.newOrderLinkReview.findUnique.mockResolvedValue(null);
  });

  it('blocks payouts and records the review for a block decision', async () => {
    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts).toEqual({ blocked: 1, queued: 0, skipped: 0 });
    expect(dbMock.dbWrite.newOrderPlayer.updateMany).toHaveBeenCalledWith({
      where: { userId: { in: [1, 2, 3] }, payoutBlockedAt: null },
      data: expect.objectContaining({ payoutBlockReason: AUTO_BLOCK_REASON, payoutBlockedBy: -1 }),
    });
    expect(upserts()[0].create).toMatchObject({
      status: 'Blocked',
      autoBlocked: true,
      buzzMoved: 250,
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-order-link-auto-block' })
    );
  });

  it('queues a review decision without touching payouts', async () => {
    const counts = await persistLinkedClusters([cluster([1, 2], 'review')]);

    expect(counts).toEqual({ blocked: 0, queued: 1, skipped: 0 });
    expect(dbMock.dbWrite.newOrderPlayer.updateMany).not.toHaveBeenCalled();
    expect(upserts()[0].create).toMatchObject({ status: 'Pending', autoBlocked: false });
  });

  it('downgrades a block to review when a member was cleared by a moderator before', async () => {
    dbMock.dbRead.newOrderLinkReview.findMany.mockResolvedValue([
      { fingerprint: 'other', userIds: [2, 9] },
    ]);

    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts.queued).toBe(1);
    expect(dbMock.dbWrite.newOrderPlayer.updateMany).not.toHaveBeenCalled();
  });

  it('leaves decided reviews alone on later runs', async () => {
    dbMock.dbWrite.newOrderLinkReview.findUnique.mockResolvedValue({ status: 'Blocked' });

    const counts = await persistLinkedClusters([cluster([1, 2, 3], 'block')]);

    expect(counts).toEqual({ blocked: 0, queued: 0, skipped: 1 });
    expect(dbMock.dbWrite.newOrderPlayer.updateMany).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
  });
});

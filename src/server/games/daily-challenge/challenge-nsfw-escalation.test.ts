import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockRefundMultiAccountTransaction,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockDbRead: {
    challenge: { findUnique: vi.fn() },
    collection: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    challenge: { update: vi.fn() },
    collection: { updateMany: vi.fn() },
  },
  mockRefundMultiAccountTransaction: vi.fn(),
  mockCreateNotification: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/buzz.service', () => ({
  refundMultiAccountTransaction: mockRefundMultiAccountTransaction,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

const { applyChallengeNsfwEscalation } = await import('./challenge-nsfw-escalation');

const PG_PG13 = 3; // NsfwLevel.PG | NsfwLevel.PG13
const R = 4;

function greenChallenge(overrides: Record<string, unknown> = {}) {
  return {
    allowedNsfwLevel: PG_PG13,
    buzzType: 'green',
    source: 'User',
    basePrizePool: 100,
    createdById: 7,
    collectionId: 55,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.challenge.update.mockResolvedValue({});
  mockDbWrite.collection.updateMany.mockResolvedValue({ count: 1 });
  mockDbRead.collection.findUnique.mockResolvedValue({ metadata: { forcedBrowsingLevel: PG_PG13 } });
  mockRefundMultiAccountTransaction.mockResolvedValue({ refundedTransactions: [{}] });
  mockCreateNotification.mockResolvedValue(undefined);
});

describe('applyChallengeNsfwEscalation', () => {
  it('clean scan: marks Scanned, no level raise, no flip, no refund', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge());
    await applyChallengeNsfwEscalation({ entityId: 1, isNsfw: false });

    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Scanned');
    expect(data.nsfwLevel).toBe(2); // PG13
    expect(data.allowedNsfwLevel).toBe(PG_PG13);
    expect(data.buzzType).toBeUndefined();
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.updateMany).not.toHaveBeenCalled();
  });

  it('green + nsfw + prize: refunds BEFORE update, flips, zeroes pool, raises level, updates collection, notifies', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge());
    const order: string[] = [];
    mockRefundMultiAccountTransaction.mockImplementation(async () => {
      order.push('refund');
      return { refundedTransactions: [{}] };
    });
    mockDbWrite.challenge.update.mockImplementation(async () => {
      order.push('update');
      return {};
    });

    await applyChallengeNsfwEscalation({ entityId: 42, isNsfw: true });

    expect(order).toEqual(['refund', 'update']);
    expect(mockRefundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'challenge-initial-prize-42-creator',
      })
    );
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBe('yellow');
    expect(data.allowedNsfwLevel).toBe(PG_PG13 | R);
    expect(data.nsfwLevel).toBe(R);
    expect(data.basePrizePool).toBe(0);
    expect(data.prizePool).toBe(0);
    expect(data.ingestion).toBe('Scanned');

    const colData = mockDbWrite.collection.updateMany.mock.calls[0][0].data;
    expect(colData.metadata.forcedBrowsingLevel).toBe(PG_PG13 | R);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-flipped-42' })
    );
  });

  it('green + nsfw + no prize: flips, no refund', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge({ basePrizePool: 0 }));
    await applyChallengeNsfwEscalation({ entityId: 3, isNsfw: true });
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBe('yellow');
    expect(data.basePrizePool).toBeUndefined();
  });

  it('already-yellow retry: no flip, no refund (idempotent)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(greenChallenge({ buzzType: 'yellow', basePrizePool: 0 }));
    await applyChallengeNsfwEscalation({ entityId: 9, isNsfw: true });
    expect(mockRefundMultiAccountTransaction).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.buzzType).toBeUndefined();
    expect(data.allowedNsfwLevel).toBe(PG_PG13 | R); // level still raised
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-raised-9' })
    );
  });

  it('missing challenge: no-op', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);
    await applyChallengeNsfwEscalation({ entityId: 404, isNsfw: true });
    expect(mockDbWrite.challenge.update).not.toHaveBeenCalled();
  });
});

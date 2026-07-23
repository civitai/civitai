import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockVoidChallenge,
  mockCreateNotification,
  mockLogToAxiom,
  mockCloseChallengeCollection,
} = vi.hoisted(() => ({
  mockDbRead: {
    challenge: { findUnique: vi.fn() },
    collection: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    challenge: { update: vi.fn() },
    collection: { updateMany: vi.fn() },
  },
  mockVoidChallenge: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockLogToAxiom: vi.fn(),
  mockCloseChallengeCollection: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/challenge.service', () => ({ voidChallenge: mockVoidChallenge }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  closeChallengeCollection: mockCloseChallengeCollection,
}));

const { applyChallengeNsfwEscalation } = await import('./challenge-nsfw-escalation');

const PG_PG13 = 3; // NsfwLevel.PG | NsfwLevel.PG13
const R = 4;

function challenge(overrides: Record<string, unknown> = {}) {
  return {
    allowedNsfwLevel: PG_PG13,
    buzzType: 'green',
    source: 'User',
    createdById: 7,
    collectionId: 55,
    status: 'Scheduled',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.challenge.update.mockResolvedValue({});
  mockDbWrite.collection.updateMany.mockResolvedValue({ count: 1 });
  mockDbRead.collection.findUnique.mockResolvedValue({ metadata: { forcedBrowsingLevel: PG_PG13 } });
  mockVoidChallenge.mockResolvedValue({ success: true, voided: true });
  mockCreateNotification.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
  mockCloseChallengeCollection.mockResolvedValue(undefined);
});

describe('applyChallengeNsfwEscalation', () => {
  it('clean scan: marks Scanned, no void, no level raise, no collection update', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge());
    await applyChallengeNsfwEscalation({ entityId: 1, isNsfw: false });

    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Scanned');
    expect(data.nsfwLevel).toBe(2); // PG13
    expect(data.allowedNsfwLevel).toBe(PG_PG13);
    expect(mockVoidChallenge).not.toHaveBeenCalled();
    expect(mockDbWrite.collection.updateMany).not.toHaveBeenCalled();
  });

  it('green user + nsfw: voids BEFORE marking Scanned, notifies cancelled, no level raise/collection update', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge());
    const order: string[] = [];
    mockVoidChallenge.mockImplementation(async () => {
      order.push('void');
      return { success: true };
    });
    mockDbWrite.challenge.update.mockImplementation(async () => {
      order.push('update');
      return {};
    });

    await applyChallengeNsfwEscalation({ entityId: 42, isNsfw: true });

    expect(order).toEqual(['void', 'update']);
    expect(mockVoidChallenge).toHaveBeenCalledWith(42);
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Scanned');
    expect(data.nsfwLevel).toBeUndefined(); // cancel path does not raise the level
    expect(data.buzzType).toBeUndefined();
    expect(mockDbWrite.collection.updateMany).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-cancelled-42' })
    );
  });

  it('yellow user + nsfw: raises to R, updates collection, notifies raised, does NOT void', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ buzzType: 'yellow' }));
    await applyChallengeNsfwEscalation({ entityId: 9, isNsfw: true });

    expect(mockVoidChallenge).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.allowedNsfwLevel).toBe(PG_PG13 | R);
    expect(data.nsfwLevel).toBe(R);
    const colData = mockDbWrite.collection.updateMany.mock.calls[0][0].data;
    expect(colData.metadata.forcedBrowsingLevel).toBe(PG_PG13 | R);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-raised-9' })
    );
  });

  it('missing challenge: no-op', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);
    await applyChallengeNsfwEscalation({ entityId: 404, isNsfw: true });
    expect(mockDbWrite.challenge.update).not.toHaveBeenCalled();
    expect(mockVoidChallenge).not.toHaveBeenCalled();
  });

  it('green user + nsfw while Active: voids (refunds pool + notifies entrants) and hides via Blocked', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ status: 'Active' }));

    await applyChallengeNsfwEscalation({ entityId: 77, isNsfw: true });

    // voidChallenge owns the Active -> Cancelled claim that keeps the completion cron from paying
    // winners out of the pool being refunded, plus the entrant refund + cancellation notices.
    expect(mockVoidChallenge).toHaveBeenCalledWith(77);
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Blocked');
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'challenge-nsfw-cancelled-77' })
    );
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-nsfw-escalation-voided', challengeId: 77 })
    );
  });

  it('green user + nsfw while Active but void claim lost: holds, and never claims a refund happened', async () => {
    // The completion cron won the Active -> Completing race, so voidChallenge refunded nothing.
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ status: 'Active' }));
    mockVoidChallenge.mockResolvedValue({ success: true, voided: false });

    await applyChallengeNsfwEscalation({ entityId: 79, isNsfw: true });

    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Blocked');
    // Telling the creator "entrants have been refunded" here would be a false financial statement.
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-nsfw-escalation-held', challengeId: 79 })
    );
  });

  it('green user + nsfw while already Cancelled: never re-enters the refund', async () => {
    // The moderation webhook can redeliver the same workflow; re-voiding would re-run the refund.
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ status: 'Cancelled' }));

    await applyChallengeNsfwEscalation({ entityId: 80, isNsfw: true });

    expect(mockVoidChallenge).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Blocked');
  });

  it('green user + nsfw while Completing: holds for review instead of refunding a pool in payout', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ status: 'Completing' }));

    await applyChallengeNsfwEscalation({ entityId: 78, isNsfw: true });

    // Refunding here would double-spend against the winner payout.
    expect(mockVoidChallenge).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Blocked');
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockCloseChallengeCollection).toHaveBeenCalledWith({ collectionId: 55 });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-nsfw-escalation-held', challengeId: 78 })
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbRead, mockDbWrite, mockVoidChallenge, mockCreateNotification, mockLogToAxiom } =
  vi.hoisted(() => ({
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
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/challenge.service', () => ({ voidChallenge: mockVoidChallenge }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

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
  mockVoidChallenge.mockResolvedValue({ success: true });
  mockCreateNotification.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
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

  it('green user + nsfw while Active: hides via Blocked + alerts mods, no void, no refund, no cancel notif', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(challenge({ status: 'Active' }));

    await applyChallengeNsfwEscalation({ entityId: 77, isNsfw: true });

    expect(mockVoidChallenge).not.toHaveBeenCalled();
    const data = mockDbWrite.challenge.update.mock.calls[0][0].data;
    expect(data.ingestion).toBe('Blocked');
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-nsfw-escalation-held', challengeId: 77 })
    );
  });
});

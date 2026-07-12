import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockRefundUserChallengeFunds,
  mockQueueUpdate,
} = vi.hoisted(() => ({
  mockDbRead: {
    challenge: { findUnique: vi.fn() },
    collectionItem: { count: vi.fn().mockResolvedValue(0) },
  },
  mockDbWrite: {
    challenge: { delete: vi.fn().mockResolvedValue(undefined) },
    collection: { delete: vi.fn().mockResolvedValue(undefined) },
  },
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockQueueUpdate: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockQueueUpdate },
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { deleteUserChallenge } = await import('~/server/services/challenge.service');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const OWNER = 42;
const makeChallenge = (o: Record<string, unknown> = {}) => ({
  id: 1,
  source: ChallengeSource.User,
  createdById: OWNER,
  status: ChallengeStatus.Scheduled,
  collectionId: 100,
  ...o,
});

describe('deleteUserChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.collectionItem.count.mockResolvedValue(0);
  });

  it('owner + Scheduled + 0 entries: refunds and deletes', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    const res = await deleteUserChallenge({ id: 1, userId: OWNER });
    expect(res).toEqual({ success: true });
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1);
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockDbWrite.collection.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  it('rejects non-owner', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge({ createdById: 999 }));
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(
      /your own challenges/i
    );
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects non-User source', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ source: ChallengeSource.System })
    );
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects non-Scheduled status', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Active })
    );
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects when entries exist', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbRead.collectionItem.count.mockResolvedValue(3);
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(/entries/i);
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('missing challenge throws NOT_FOUND', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(null);
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(/not found/i);
  });
});

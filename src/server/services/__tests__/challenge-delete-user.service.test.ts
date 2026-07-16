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
    challenge: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    collection: { delete: vi.fn().mockResolvedValue(undefined) },
    $transaction: vi.fn(),
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

const { deleteUserChallenge, deleteChallenge } = await import(
  '~/server/services/challenge.service'
);
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
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
    mockDbWrite.$transaction.mockImplementation(async (fn: any) =>
      fn({ challenge: mockDbWrite.challenge, collection: mockDbWrite.collection })
    );
  });

  it('owner + Scheduled + 0 entries: claims, refunds and deletes', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbWrite.challenge.findUnique.mockResolvedValue(makeChallenge());
    const res = await deleteUserChallenge({ id: 1, userId: OWNER });
    expect(res).toEqual({ success: true });
    // Atomic claim (Scheduled -> Cancelled) gates the refund.
    expect(mockDbWrite.challenge.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: ChallengeStatus.Scheduled },
      data: { status: ChallengeStatus.Cancelled },
    });
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1);
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockDbWrite.collection.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  it('lost claim (concurrent delete / activation race): does NOT refund or delete', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbWrite.challenge.findUnique.mockResolvedValue(makeChallenge());
    // Another caller (or the activation job) already flipped the row out of Scheduled.
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 0 });
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(
      /no longer in a deletable state/i
    );
    expect(mockRefundUserChallengeFunds).not.toHaveBeenCalled();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
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

describe('deleteChallenge (direct)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
    mockDbWrite.$transaction.mockImplementation(async (fn: any) =>
      fn({ challenge: mockDbWrite.challenge, collection: mockDbWrite.collection })
    );
  });

  it('already-Cancelled User challenge: re-refunds idempotently without re-claiming, then deletes', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Cancelled })
    );
    await deleteChallenge(1);
    // No claim on an already-Cancelled row (nothing to flip); refund is the idempotent recovery.
    expect(mockDbWrite.challenge.updateMany).not.toHaveBeenCalled();
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1);
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('fails atomically when collection deletion fails', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbWrite.collection.delete.mockRejectedValueOnce(new Error('collection delete failed'));

    await expect(deleteChallenge(1)).rejects.toThrow(/collection delete failed/i);
    expect(mockQueueUpdate).not.toHaveBeenCalled();
  });

  it('blocks deleting an Active challenge', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Active })
    );
    await expect(deleteChallenge(1)).rejects.toThrow(/active/i);
    expect(mockRefundUserChallengeFunds).not.toHaveBeenCalled();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });
});

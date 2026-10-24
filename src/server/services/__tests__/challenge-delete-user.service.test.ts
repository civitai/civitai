import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
dbMock.dbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
dbMock.dbWrite.challenge.delete.mockResolvedValue(undefined);
dbMock.dbWrite.collection.delete.mockResolvedValue(undefined);

const { mockRefundUserChallengeFunds, mockQueueUpdate } = vi.hoisted(() => ({
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockQueueUpdate: vi.fn(),
}));

const txClient = () => ({
  challenge: mockDbWrite.challenge,
  collection: mockDbWrite.collection,
});

// `$executeRaw` resolves 0 by default (db.mock), which ends the batch loop on its first pass.
const detachCallIndex = () =>
  mockDbWrite.$executeRaw.mock.calls.findIndex(([strings]: [string[]]) =>
    strings.join('?').includes('UPDATE "Post"')
  );

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
    mockDbWrite.$transaction.mockImplementation(async (fn: any) => fn(txClient()));
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
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1, 'delete');
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

  it('rejects Active status', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Active })
    );
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow();
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('rejects when entries exist on a Scheduled challenge', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbRead.collectionItem.count.mockResolvedValue(3);
    await expect(deleteUserChallenge({ id: 1, userId: OWNER })).rejects.toThrow(/entries/i);
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
  });

  it('owner + Cancelled: deletes regardless of entries (idempotent refund, no re-claim)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Cancelled })
    );
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Cancelled })
    );
    // Entries present, but a Cancelled (mod-voided) challenge must not be entry-gated.
    mockDbRead.collectionItem.count.mockResolvedValue(5);
    const res = await deleteUserChallenge({ id: 1, userId: OWNER });
    expect(res).toEqual({ success: true });
    // No entry-count gate for Cancelled — collectionItem.count is never consulted.
    expect(mockDbRead.collectionItem.count).not.toHaveBeenCalled();
    // Already-Cancelled: no Scheduled->Cancelled claim; refund is the idempotent net-zero recovery.
    expect(mockDbWrite.challenge.updateMany).not.toHaveBeenCalled();
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1, 'delete');
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(mockDbWrite.collection.delete).toHaveBeenCalledWith({ where: { id: 100 } });
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
    mockDbWrite.$transaction.mockImplementation(async (fn: any) => fn(txClient()));
  });

  it('already-Cancelled User challenge: re-refunds idempotently without re-claiming, then deletes', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Cancelled })
    );
    await deleteChallenge(1);
    // No claim on an already-Cancelled row (nothing to flip); refund is the idempotent recovery.
    expect(mockDbWrite.challenge.updateMany).not.toHaveBeenCalled();
    expect(mockRefundUserChallengeFunds).toHaveBeenCalledWith(1, 'delete');
    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('leaves the collection intact and retryable when its deletion fails', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(makeChallenge());
    mockDbWrite.collection.delete.mockRejectedValueOnce(new Error('collection delete failed'));

    await expect(deleteChallenge(1)).rejects.toThrow(/collection delete failed/i);
    expect(mockQueueUpdate).not.toHaveBeenCalled();

    // The detach is outside the transaction on purpose, so it stays committed here. That is the
    // retry-safety the helper's docstring claims: the posts have merely left a collection that
    // still exists, and re-running the delete finishes the job.
    expect(detachCallIndex()).toBeGreaterThanOrEqual(0);
  });

  it('detaches entrant posts before dropping the collection', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Cancelled })
    );

    await deleteChallenge(1);

    // Order is the whole guarantee: dropping the collection first cascades away every entrant's
    // post (see detachPostsFromCollection).
    const detachIndex = detachCallIndex();
    expect(detachIndex).toBeGreaterThanOrEqual(0);
    const [strings, ...values] = mockDbWrite.$executeRaw.mock.calls[detachIndex];

    // The WHERE column, not just the UPDATE prefix: selecting on `id` instead of `collectionId`
    // detaches one unrelated post and cascades every entrant's away.
    expect(strings.join('?')).toMatch(
      /UPDATE "Post" SET "collectionId" = NULL\s+WHERE id IN \(\s*SELECT id FROM "Post" WHERE "collectionId" = \?/
    );
    expect(values[0]).toBe(100);
    // Indexed off the detach itself, not `[0]` — any other raw write on this path would otherwise
    // be the call being ordered.
    expect(mockDbWrite.$executeRaw.mock.invocationCallOrder[detachIndex]).toBeLessThan(
      mockDbWrite.collection.delete.mock.invocationCallOrder[0]
    );
  });

  it.each([['Completed'], ['Completing']])(
    'refuses a %s challenge without force, so winner records survive',
    async (status) => {
      mockDbWrite.challenge.findUnique.mockResolvedValue(
        makeChallenge({ status: ChallengeStatus[status as 'Completed' | 'Completing'] })
      );

      // `ChallengeWinner` cascades on the challenge row, and the prize Buzz is already spent.
      await expect(deleteChallenge(1)).rejects.toThrow(/already awarded prizes/i);
      expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
      expect(mockDbWrite.collection.delete).not.toHaveBeenCalled();
      // Nothing may run ahead of the guard either — a detached entrant post is not undone by the
      // delete failing.
      expect(detachCallIndex()).toBe(-1);
    }
  );

  it('deletes a Completed challenge when force is passed', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Completed })
    );

    await deleteChallenge(1, { force: true });

    expect(mockDbWrite.challenge.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    // A Completed pool was already paid out; refunding it would double-spend from account 0.
    expect(mockRefundUserChallengeFunds).not.toHaveBeenCalled();
  });

  it('blocks an Active challenge even with force', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(
      makeChallenge({ status: ChallengeStatus.Active })
    );
    await expect(deleteChallenge(1, { force: true })).rejects.toThrow(/active/i);
    expect(mockDbWrite.challenge.delete).not.toHaveBeenCalled();
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

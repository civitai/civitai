import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDbWrite, mockGetChallengeById, mockCloseCollection, mockRefund } = vi.hoisted(() => ({
  mockDbWrite: { challenge: { updateMany: vi.fn() } },
  mockGetChallengeById: vi.fn(),
  mockCloseCollection: vi.fn().mockResolvedValue(undefined),
  mockRefund: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
}));

vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: mockDbWrite }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  buildWinnerPayoutTransactions: vi.fn(),
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefund,
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getChallengeById: mockGetChallengeById,
  closeChallengeCollection: mockCloseCollection,
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { voidChallenge } = await import('~/server/services/challenge.service');
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const makeChallenge = (status: (typeof ChallengeStatus)[keyof typeof ChallengeStatus]) => ({
  id: 1,
  status,
  collectionId: 100,
  source: ChallengeSource.User,
  createdById: 5,
  title: 'Test',
});

describe('voidChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefund.mockResolvedValue({ refundedEntries: 0 });
    mockCloseCollection.mockResolvedValue(undefined);
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 1 });
  });

  it('Active: atomically claims Active/Scheduled -> Cancelled, then refunds', async () => {
    mockGetChallengeById.mockResolvedValue(makeChallenge(ChallengeStatus.Active));
    await voidChallenge(1);
    expect(mockDbWrite.challenge.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: { in: [ChallengeStatus.Active, ChallengeStatus.Scheduled] } },
      data: { status: ChallengeStatus.Cancelled },
    });
    expect(mockRefund).toHaveBeenCalledWith(1);
  });

  it('claim lost (completion cron or a concurrent void won): does NOT refund', async () => {
    mockGetChallengeById.mockResolvedValue(makeChallenge(ChallengeStatus.Active));
    mockDbWrite.challenge.updateMany.mockResolvedValue({ count: 0 });
    const res = await voidChallenge(1);
    // `voided: false` is what lets callers avoid reporting a refund that never happened.
    expect(res).toEqual({ success: true, voided: false });
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('retry on already-Cancelled: skips the claim and re-refunds (idempotent recovery)', async () => {
    mockGetChallengeById.mockResolvedValue(makeChallenge(ChallengeStatus.Cancelled));
    await voidChallenge(1);
    expect(mockDbWrite.challenge.updateMany).not.toHaveBeenCalled();
    expect(mockRefund).toHaveBeenCalledWith(1);
  });

  it('rejects a Completed/Completing challenge (pool already paid out)', async () => {
    mockGetChallengeById.mockResolvedValue(makeChallenge(ChallengeStatus.Completed));
    await expect(voidChallenge(1)).rejects.toThrow(/must be Active, Scheduled, or Cancelled/i);
    expect(mockRefund).not.toHaveBeenCalled();
  });
});

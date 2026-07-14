import { beforeEach, describe, expect, it, vi } from 'vitest';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';

describe('challenge-cancelled notification definition', () => {
  const def = (challengeNotifications as Record<string, (typeof challengeNotifications)['challenge-winner']>)[
    'challenge-cancelled'
  ];

  it('is registered as a non-toggleable System notification', () => {
    expect(def).toBeTruthy();
    expect(def.toggleable).toBe(false);
  });

  it('renders a message naming the challenge and the refunded pool amount, without implying a full refund', () => {
    const msg = def.prepareMessage({
      details: { challengeId: 42, challengeTitle: 'Neon Dreams', refundedBuzz: 175 },
    });
    expect(msg).toBeTruthy();
    expect(msg!.message).toContain('Neon Dreams');
    expect(msg!.message).toContain('175');
    expect(msg!.message.toLowerCase()).toMatch(/cancel/);
    // House cut (25/entry) is retained — copy must not claim a full refund.
    expect(msg!.message.toLowerCase()).not.toMatch(/full refund/);
    expect(msg!.url).toBe('/challenges/42');
  });
});

const {
  mockDbRead,
  mockDbWrite,
  mockGetChallengeById,
  mockCloseChallengeCollection,
  mockRefundUserChallengeFunds,
  mockCreateNotification,
} = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { challenge: { update: vi.fn().mockResolvedValue(undefined) } },
  mockGetChallengeById: vi.fn(),
  mockCloseChallengeCollection: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn(),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  getChallengeById: mockGetChallengeById,
  closeChallengeCollection: mockCloseChallengeCollection,
  claimChallengeForCompletion: vi.fn(),
  buildChallengeModerationText: vi.fn(),
  createChallengeWinner: vi.fn(),
  distributePrizes: vi.fn(),
  getChallengeWinners: vi.fn(),
  getExistingWinnersForRetry: vi.fn(),
  resolveEventContext: vi.fn(),
}));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { voidChallenge } = await import('~/server/services/challenge.service');
const { ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const CHALLENGE = {
  id: 7,
  status: ChallengeStatus.Active,
  collectionId: 55,
  createdById: 9,
  title: 'Retro Wave',
  entryFee: 100,
};

describe('voidChallenge — entrant cancellation notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeById.mockResolvedValue(CHALLENGE);
  });

  it('notifies distinct paying entrants (excluding the creator) after a refund', async () => {
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 3 });
    mockDbRead.$queryRaw.mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 9 }]);

    await voidChallenge(7);

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('challenge-cancelled');
    expect([...call.userIds].sort()).toEqual([1, 2]);
    expect(call.details.challengeTitle).toBe('Retro Wave');
  });

  it('skips notification when nothing was refunded (no entry fee / no paid entrants)', async () => {
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });

    await voidChallenge(7);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

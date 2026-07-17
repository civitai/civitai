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
  mockLogToAxiom,
  mockIsFlipt,
  mockGetJudgedEntries,
  mockGenerateWinners,
  mockGetJudgingConfig,
  mockGetChallengeConfig,
} = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: {
    challenge: {
      update: vi.fn().mockResolvedValue(undefined),
      // voidChallenge claims the row Active/Scheduled -> Cancelled via updateMany and
      // requires claimed.count === 1 to proceed to the refund + entrant-notification path;
      // default to a successful single-row claim so the tests exercise that path.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      // Final-prize recompute (User source, endChallengeAndPickWinners only) — null distribution
      // skips it so the zero-winner tests exercise the notification branch unchanged.
      findUnique: vi.fn().mockResolvedValue({ prizePool: 0, prizeDistribution: null }),
    },
  },
  mockGetChallengeById: vi.fn(),
  mockCloseChallengeCollection: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn(),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  mockIsFlipt: vi.fn().mockResolvedValue(false),
  mockGetJudgedEntries: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockGetJudgingConfig: vi.fn().mockResolvedValue({
    judgeId: 1,
    userId: 999,
    sourceCollectionId: null,
    prompts: {},
    reviewTemplate: null,
  }),
  mockGetChallengeConfig: vi.fn().mockResolvedValue({
    defaultJudgeId: 1,
    defaultJudge: null,
    judgedTagId: 1,
    reviewMeTagId: 2,
    winnerCooldown: '7 day',
    finalReviewAmount: 10,
    maxScoredPerUser: 5,
    reviewAmount: { min: 6, max: 12 },
  }),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  getChallengeById: mockGetChallengeById,
  closeChallengeCollection: mockCloseChallengeCollection,
  claimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  buildChallengeModerationText: vi.fn(),
  createChallengeWinner: vi.fn(),
  distributePrizes: vi.fn(),
  getChallengeWinners: vi.fn(),
  getExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  resolveEventContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

// endChallengeAndPickWinners (zero-winner branch tests below) pulls in a much wider module graph
// than voidChallenge — mirrors the working setup in
// src/server/services/__tests__/challenge-judging-categories-gate.service.test.ts.
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: mockIsFlipt };
});
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: mockGetJudgingConfig,
}));
vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn(),
  generateWinners: mockGenerateWinners,
}));
vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getCoverOfModel: vi.fn(),
  getJudgedEntries: mockGetJudgedEntries,
}));
vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn() },
}));
vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));
vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
}));
vi.mock('~/server/integrations/moderation', () => ({
  extModeration: {},
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

const { voidChallenge, endChallengeAndPickWinners } = await import(
  '~/server/services/challenge.service'
);
const { ChallengeSource, ChallengeStatus } = await import('~/shared/utils/prisma/enums');

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

  it('is best-effort: a notification failure is logged and swallowed, and the status flip to Cancelled still completes', async () => {
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 3 });
    mockDbRead.$queryRaw.mockRejectedValue(new Error('transient DB error'));

    await expect(voidChallenge(7)).resolves.toEqual({ success: true });

    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockLogToAxiom).toHaveBeenCalledTimes(1);
    const logCall = mockLogToAxiom.mock.calls[0][0];
    expect(logCall.name).toBe('challenge-cancelled-notification');
    expect(logCall.challengeId).toBe(7);
    expect(logCall.message).toBe('transient DB error');
    // The refund already happened, so money movement isn't blocked by the notification failure —
    // the status claim (Active/Scheduled -> Cancelled) must still have run.
    expect(mockDbWrite.challenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: 7,
        status: { in: [ChallengeStatus.Active, ChallengeStatus.Scheduled] },
      },
      data: { status: ChallengeStatus.Cancelled },
    });
  });
});

const USER_CHALLENGE = {
  ...CHALLENGE,
  source: ChallengeSource.User,
  judgeId: null,
  judgingPrompt: null,
  eventId: null,
  judgingCategories: null,
  prizes: [],
};

describe('endChallengeAndPickWinners — zero-winner entrant cancellation notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeById.mockResolvedValue(USER_CHALLENGE);
    mockGetChallengeConfig.mockResolvedValue({
      defaultJudgeId: 1,
      defaultJudge: null,
      judgedTagId: 1,
      reviewMeTagId: 2,
      winnerCooldown: '7 day',
      finalReviewAmount: 10,
      maxScoredPerUser: 5,
      reviewAmount: { min: 6, max: 12 },
    });
    mockGetJudgingConfig.mockResolvedValue({
      judgeId: 1,
      userId: 999,
      sourceCollectionId: null,
      prompts: {},
      reviewTemplate: null,
    });
    // No judged entries triggers the zero-winner refund branch — the one that reuses
    // notifyEntrantsOfCancellation, same as voidChallenge.
    mockGetJudgedEntries.mockResolvedValue([]);
  });

  it('notifies distinct paying entrants (excluding the creator) after a refund with no winners', async () => {
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 2 });
    mockDbRead.$queryRaw.mockResolvedValue([{ userId: 1 }, { userId: 2 }, { userId: 9 }]);

    const result = await endChallengeAndPickWinners(7);

    expect(result).toEqual({ success: true, winnersCount: 0 });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    const call = mockCreateNotification.mock.calls[0][0];
    expect(call.type).toBe('challenge-cancelled');
    expect([...call.userIds].sort()).toEqual([1, 2]);
    expect(mockDbWrite.challenge.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ status: ChallengeStatus.Completed }),
    });
  });

  it('skips notification when nothing was refunded', async () => {
    mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });

    await endChallengeAndPickWinners(7);

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

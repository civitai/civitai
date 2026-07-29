import { describe, it, expect, vi, beforeEach } from 'vitest';

// Covers two invariants that are easy to silently revert:
//   1. `rescanChallenge` never resets ingestion/scannedAt — that reset is what stranded challenges
//      at Pending in #3160, and leaving it out is what keeps a live challenge visible mid-scan.
//   2. `getWinnerCooldownStatus` reports no cooldown for user-created challenges, matching
//      pickWinners (daily-challenge-processing.ts), which skips the cooldown for source=User.
const {
  mockDbRead,
  mockDbWrite,
  mockSubmitTextModeration,
  mockEnqueueImageIngestion,
  mockGetChallengeConfig,
  mockResolveEventContext,
} = vi.hoisted(() => ({
  mockDbRead: {
    $queryRaw: vi.fn(),
    challenge: { findUnique: vi.fn() },
    image: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    challenge: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
  mockSubmitTextModeration: vi.fn(),
  mockEnqueueImageIngestion: vi.fn(),
  mockGetChallengeConfig: vi.fn(),
  mockResolveEventContext: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
  parseJudgeScore: vi.fn(),
}));

// buildChallengeModerationText drives the submitted content, so keep the real implementation.
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('~/server/games/daily-challenge/challenge-helpers')
  >();
  return { ...actual, getChallengeById: vi.fn(), resolveEventContext: mockResolveEventContext };
});

vi.mock('~/server/games/daily-challenge/generative-content', () => ({ generateWinners: vi.fn() }));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({ getJudgedEntries: vi.fn() }));

vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  enqueueImageIngestion: mockEnqueueImageIngestion,
  imagesForModelVersionsCache: { bust: vi.fn(), fetch: vi.fn(() => ({})) },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
  assertUserInGoodStanding: vi.fn(),
  assertUserAccountInGoodStanding: vi.fn(),
}));

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: vi.fn(() => []),
}));

vi.mock('~/server/services/challenge-judge.service', () => ({
  getUserSelectableJudges: vi.fn(() => []),
}));

vi.mock('~/server/services/text-moderation.service', () => ({
  submitTextModeration: mockSubmitTextModeration,
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(() => Promise.resolve()) }));

vi.mock('~/utils/errorHandling', () => ({ withRetries: vi.fn((fn: () => unknown) => fn()) }));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

vi.mock('~/server/utils/errorHandling', () => ({
  throwNotFoundError: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

const { rescanChallenge, getWinnerCooldownStatus } = await import(
  '~/server/services/challenge.service'
);

const challengeRow = {
  title: 'Cute Cats with Silly Hats',
  description: '<p>Show us your best cat.</p>',
  theme: 'Cats',
  invitation: null,
  metadata: null,
  coverImageId: 900,
  createdById: 111,
};

describe('rescanChallenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWrite.challenge.findUnique.mockResolvedValue(challengeRow);
    mockDbRead.image.findUnique.mockResolvedValue({
      id: 900,
      url: 'abc',
      type: 'image',
      ingestion: 'Scanned',
    });
    mockSubmitTextModeration.mockResolvedValue({ id: 'wf-1' });
  });

  it('forces a fresh scan and never touches ingestion or scannedAt', async () => {
    await rescanChallenge({ id: 42, moderatorId: 7 });

    expect(mockSubmitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'Challenge', entityId: 42, forceRescan: true })
    );
    // The reset is the #3160 deadlock, and it would also hide a live Active challenge mid-scan.
    expect(mockDbWrite.challenge.update).not.toHaveBeenCalled();
    expect(mockDbWrite.challenge.updateMany).not.toHaveBeenCalled();
  });

  it('re-queues the cover image for ingestion', async () => {
    await rescanChallenge({ id: 42, moderatorId: 7 });

    expect(mockEnqueueImageIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ images: [expect.objectContaining({ id: 900 })] })
    );
  });

  it('skips a cover image that is already mid-scan', async () => {
    mockDbRead.image.findUnique.mockResolvedValue({
      id: 900,
      url: 'abc',
      type: 'image',
      ingestion: 'Pending',
    });

    await rescanChallenge({ id: 42, moderatorId: 7 });

    expect(mockEnqueueImageIngestion).not.toHaveBeenCalled();
    expect(mockSubmitTextModeration).toHaveBeenCalled();
  });

  it('throws when the moderation submit produced no workflow', async () => {
    // submitTextModeration resolves undefined on submit failure rather than throwing, so without
    // this the moderator sees a "rescan queued" confirmation for a scan that never happened.
    mockSubmitTextModeration.mockResolvedValue(undefined);

    await expect(rescanChallenge({ id: 42, moderatorId: 7 })).rejects.toThrow();
  });

  it('throws when the challenge does not exist', async () => {
    mockDbWrite.challenge.findUnique.mockResolvedValue(null);

    await expect(rescanChallenge({ id: 42, moderatorId: 7 })).rejects.toThrow();
  });
});

describe('getWinnerCooldownStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChallengeConfig.mockResolvedValue({ winnerCooldown: '7 day' });
    mockResolveEventContext.mockResolvedValue({ eventId: null, winnerCooldownDays: null });
  });

  it('reports no cooldown on a user-created challenge even with a recent win', async () => {
    mockDbRead.$queryRaw.mockResolvedValueOnce([{ eventId: null, source: 'User' }]);

    const result = await getWinnerCooldownStatus(42, 111);

    expect(result.onCooldown).toBe(false);
    expect(result.cooldownEndsAt).toBeNull();
    // Short-circuits before the ChallengeWinner lookup — pickWinners never applies the cooldown
    // to user challenges, so reporting one would warn about an unenforced restriction.
    expect(mockDbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('still reports a cooldown on a system challenge', async () => {
    const lastWin = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    mockDbRead.$queryRaw
      .mockResolvedValueOnce([{ eventId: null, source: 'System' }])
      .mockResolvedValueOnce([{ createdAt: lastWin, challengeId: 9 }]);

    const result = await getWinnerCooldownStatus(42, 111);

    expect(result.onCooldown).toBe(true);
    expect(result.lastWinChallengeId).toBe(9);
  });
});

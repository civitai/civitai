import { describe, it, expect, vi, beforeEach } from 'vitest';

// JUDGE_USER_ID/CREATOR_USER_ID must be defined inside vi.hoisted() itself: its callback runs
// before any top-level `const` in this file initializes, so referencing an outer const here
// throws a TDZ error ("Cannot access 'JUDGE_USER_ID' before initialization").
const {
  mockDbRead,
  mockDbWrite,
  mockTx,
  mockCreateImage,
  mockGetChallengeConfig,
  JUDGE_USER_ID,
  CREATOR_USER_ID,
} = vi.hoisted(() => {
  const JUDGE_USER_ID = 8_675_309;
  const CREATOR_USER_ID = 42;
  const tx = {
    challenge: {
      update: vi.fn().mockResolvedValue({ id: 1 }),
      create: vi.fn().mockResolvedValue({ id: 2, collectionId: 10 }),
    },
    collection: {
      create: vi.fn().mockResolvedValue({ id: 10 }),
      update: vi.fn().mockResolvedValue({ id: 10 }),
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  };
  return {
    JUDGE_USER_ID,
    CREATOR_USER_ID,
    mockTx: tx,
    mockDbRead: {
      challenge: { findUnique: vi.fn() },
      challengeJudge: { findUnique: vi.fn().mockResolvedValue({ userId: JUDGE_USER_ID }) },
    },
    mockDbWrite: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) },
    mockCreateImage: vi.fn(),
    mockGetChallengeConfig: vi.fn().mockResolvedValue({ defaultJudgeId: 1 }),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  isFlipt: vi.fn().mockResolvedValue(false),
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  claimChallengeForCompletion: vi.fn(),
  closeChallengeCollection: vi.fn(),
  createChallengeWinner: vi.fn(),
  getChallengeById: vi.fn(),
  getChallengeWinners: vi.fn().mockResolvedValue([]),
  getExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  resolveEventContext: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateThemeElements: vi.fn().mockResolvedValue([]),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({ getJudgedEntries: vi.fn() }));
vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

vi.mock('~/server/services/image.service', () => ({
  createImage: mockCreateImage,
  imagesForModelVersionsCache: { bust: vi.fn(), fetch: vi.fn(() => ({})) },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/services/challenge-category.service', () => ({
  resolveJudgingCategories: vi.fn().mockResolvedValue(null),
}));

const { upsertChallenge } = await import('~/server/services/challenge.service');

const baseInput = {
  title: 'Test challenge',
  description: 'A description',
  startsAt: new Date('2026-08-01T00:00:00Z'),
  endsAt: new Date('2026-08-05T00:00:00Z'),
  visibleAt: new Date('2026-07-29T00:00:00Z'),
  coverImage: { id: 1 },
  prizes: [],
  userId: CREATOR_USER_ID,
};

describe('upsertChallenge (create) — collection ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.challengeJudge.findUnique.mockResolvedValue({ userId: JUDGE_USER_ID });
    mockGetChallengeConfig.mockResolvedValue({ defaultJudgeId: 1 });
    mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
  });

  it('assigns the entry collection to the judge account, not the caller', async () => {
    await upsertChallenge({ ...baseInput, judgeId: 3 } as never);

    expect(mockTx.collection.create).toHaveBeenCalledTimes(1);
    const callArg = mockTx.collection.create.mock.calls[0][0];
    expect(callArg.data.userId).toBe(JUDGE_USER_ID);
    expect(callArg.data.userId).not.toBe(CREATOR_USER_ID);
    expect(mockDbRead.challengeJudge.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { userId: true },
    });
  });

  it('does not open a transaction when no judge can be resolved', async () => {
    mockDbRead.challengeJudge.findUnique.mockResolvedValue(null);

    await expect(upsertChallenge({ ...baseInput, judgeId: 3 } as never)).rejects.toThrow(
      /no challenge judge/i
    );
    expect(mockDbWrite.$transaction).not.toHaveBeenCalled();
  });
});

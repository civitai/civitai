import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression guard for the second half of the "claimed-for-completion gets clobbered" defect.
//
// `upsertChallenge`'s update branch reads the challenge from the READ REPLICA, validates its
// status, and may then spend seconds inside `tryGenerateThemeElements` (an LLM call) before it
// writes. `claimChallengeForCompletion` can flip the challenge to Completing in that window.
//
// The write used to be an unconditional `tx.challenge.update({ where: { id } })`. Because the
// Active branch pins `data.status` back to the status that was READ, that unconditional write
// would set a mid-completion challenge back to Active and restore the stale metadata snapshot
// over the fresh `completingClaimedAt` stamp — un-claiming the challenge and dropping the marker
// the stuck-challenge reset keys off. It is now a status-predicated `updateMany` + `count === 0`,
// matching the Scheduled-only edit path elsewhere in this service.

const {
  mockDbRead,
  mockDbWrite,
  mockTx,
  mockCreateImage,
  mockGenerateThemeElements,
  mockLogToAxiom,
} = vi.hoisted(() => {
  const tx = {
    challenge: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 1 }),
      create: vi.fn().mockResolvedValue({ id: 2 }),
    },
    collection: {
      create: vi.fn().mockResolvedValue({ id: 10 }),
      update: vi.fn().mockResolvedValue({ id: 10 }),
      findUnique: vi.fn().mockResolvedValue({ metadata: {} }),
    },
  };
  return {
    mockTx: tx,
    mockDbRead: {
      challenge: { findUnique: vi.fn() },
      challengeJudge: { findUnique: vi.fn().mockResolvedValue({ userId: 1 }) },
    },
    mockDbWrite: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) },
    mockCreateImage: vi.fn(),
    mockGenerateThemeElements: vi.fn().mockResolvedValue([]),
    mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  isFlipt: vi.fn().mockResolvedValue(false),
}));

// Must resolve a promise, not undefined: production `logToAxiom` is async and the guard chains
// `.catch()` on it (as two other sites in challenge.service.ts do). A bare `vi.fn()` returns
// undefined and TypeErrors — which is also what proves the guard path is genuinely exercised.
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

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
  getChallengeConfig: vi.fn().mockResolvedValue({ defaultJudgeId: 1 }),
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
  refreshDefaultJudgeCache: vi.fn(),
  parseJudgeScore: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: mockGenerateThemeElements,
  generateWinners: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/template-engine', () => ({
  reviewTemplateSchema: { safeParse: vi.fn() },
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getCoverOfModel: vi.fn(),
  getJudgedEntries: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeInitialPrize: vi.fn(),
  refundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
  getTransactionByExternalId: vi.fn(),
}));

vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

vi.mock('~/server/services/image.service', () => ({
  createImage: mockCreateImage,
  imagesForModelVersionsCache: { bust: vi.fn() },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
}));

vi.mock('~/server/integrations/moderation', () => ({ extModeration: {} }));

vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

vi.mock('~/utils/errorHandling', () => ({ withRetries: vi.fn((fn: () => unknown) => fn()) }));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { upsertChallenge } = await import('~/server/services/challenge.service');
const { ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const storedChallenge = (status: string) => ({
  collectionId: null,
  metadata: { completingClaimedAt: null },
  status,
  startsAt: new Date(Date.now() - 86400000),
  modelVersionIds: [],
  allowedNsfwLevel: 1,
  source: 'Mod',
  maxEntriesPerUser: 20,
  entryPrizeRequirement: 10,
  prizeMode: 'Fixed',
  basePrizePool: 0,
  buzzPerAction: 0,
  poolTrigger: null,
  maxPrizePool: null,
  prizeDistribution: null,
  judgingCategories: null,
});

const baseInput = {
  userId: 999,
  title: 'A test challenge',
  theme: 'Neon',
  coverImage: { id: 555, url: 'unused' },
  themeElements: ['already', 'provided'],
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  modelVersionIds: [],
  judgeId: 1,
  judgingPrompt: 'prompt',
  reviewPercentage: 100,
  maxEntriesPerUser: 20,
  prizes: [],
  entryPrizeRequirement: 10,
  prizePool: 0,
  operationBudget: 0,
  prizeMode: 'Fixed',
  basePrizePool: 0,
  buzzPerAction: 0,
  reviewCostType: 'None',
  reviewCost: 0,
  startsAt: new Date(Date.now() - 86400000),
  endsAt: new Date(Date.now() + 2 * 86400000),
  visibleAt: new Date(),
  status: ChallengeStatus.Active,
  source: 'Mod',
};

describe('upsertChallenge — must not overwrite a challenge claimed for completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.challenge.updateMany.mockResolvedValue({ count: 1 });
    mockTx.challenge.findUniqueOrThrow.mockResolvedValue({ id: 1 });
    mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
  });

  it('scopes the write to the status it validated, not to the id alone', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(storedChallenge(ChallengeStatus.Active));

    await upsertChallenge({ ...baseInput, id: 1 } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    const where = mockTx.challenge.updateMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: 1, status: ChallengeStatus.Active });
  });

  it('aborts instead of writing when the challenge was claimed mid-save', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(storedChallenge(ChallengeStatus.Active));
    // The predicate matched nothing: claimChallengeForCompletion moved it to Completing while
    // theme generation was in flight.
    mockTx.challenge.updateMany.mockResolvedValue({ count: 0 });

    await expect(upsertChallenge({ ...baseInput, id: 1 } as never)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    // Nothing downstream of the guard may run — in particular the collection must not be
    // re-dated for a challenge that is already completing.
    expect(mockTx.challenge.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(mockTx.collection.update).not.toHaveBeenCalled();
    // Rare by construction, so the log is the only way to know the guard ever fired.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-upsert-status-precondition-failed',
        challengeId: 1,
        readStatus: ChallengeStatus.Active,
      })
    );
  });

  it('returns the re-read row on a successful update', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue(storedChallenge(ChallengeStatus.Scheduled));
    mockTx.challenge.findUniqueOrThrow.mockResolvedValue({ id: 1, title: 'A test challenge' });

    const result = await upsertChallenge({
      ...baseInput,
      id: 1,
      status: ChallengeStatus.Scheduled,
    } as never);

    expect(result).toEqual({ id: 1, title: 'A test challenge' });
    expect(mockTx.challenge.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

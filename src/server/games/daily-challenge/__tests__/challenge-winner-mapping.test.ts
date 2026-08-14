import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as LoggingClient from '~/server/logging/client';
import { freshPersistedWinner } from './persisted-winner.fixture';

// Task 19: hardens the LLM-winner -> judged-entry mapping in pickWinnersForChallenge against
// creator-name spoofing. generateWinners (a TEXT-only LLM call) returns
// `{ creatorId, creator, reason }` per winner. `creator` echoes the entrant's (user-controlled,
// spoofable) display name; `creatorId` echoes the numeric, non-spoofable userId that was sent in
// the entries payload. The old mapping matched on EITHER field
// (`e.username.toLowerCase() === winner.creator.toLowerCase() || e.userId === winner.creatorId`),
// so a second entrant who set their display name equal to another entrant's name could hijack
// `Array.prototype.find`'s first-match semantics and steal that entrant's payout. Judged entries
// are already deduped to one per userId (see getJudgedEntries), so keying strictly on creatorId
// fully disambiguates without ever needing an entry/image id from the LLM.
//
// Mocking mirrors challenge-degenerate-winners.test.ts: `~/server/events` is stubbed to cut its
// heavy transitive chain, calculateWeightedScore/SCORE_WEIGHTS are pulled in real from
// daily-challenge-scoring so entry ranking math is genuine, everything else touching DB/LLM/buzz
// is mocked at the module boundary.

const {
  mockDbReadQueryRaw,
  mockDbReadChallengeFindUnique,
  mockDbWriteQueryRaw,
  mockDbWriteExecuteRaw,
  mockDbWriteChallengeUpdate,
  mockDbWriteChallengeFindUnique,
  mockGetChallengeConfig,
  mockGetJudgingConfig,
  mockEndChallenge,
  mockGetActiveChallenges,
  mockGenerateWinners,
  mockClaimChallengeForCompletion,
  mockGetExistingWinnersForRetry,
  mockResolveEventContext,
  mockUpdateChallengeStatus,
  mockRefundUserChallengeFunds,
  mockCreateNotification,
  mockCreateChallengeWinner,
  mockGetChallengeById,
  mockLogToAxiom,
} = vi.hoisted(() => ({
  mockDbReadQueryRaw: vi.fn(),
  mockDbReadChallengeFindUnique: vi.fn(),
  mockDbWriteQueryRaw: vi.fn(),
  mockDbWriteExecuteRaw: vi.fn().mockResolvedValue(1),
  mockDbWriteChallengeUpdate: vi.fn().mockResolvedValue(undefined),
  mockDbWriteChallengeFindUnique: vi.fn().mockResolvedValue({
    prizePool: 0,
    prizeDistribution: null,
  }),
  mockGetChallengeConfig: vi.fn(),
  mockGetJudgingConfig: vi.fn(),
  mockEndChallenge: vi.fn().mockResolvedValue(undefined),
  mockGetActiveChallenges: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockClaimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  mockResolveEventContext: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockCreateNotification: vi.fn().mockResolvedValue(undefined),
  mockCreateChallengeWinner: vi.fn(),
  mockGetChallengeById: vi.fn().mockResolvedValue(null),
  mockLogToAxiom: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: mockDbReadQueryRaw,
    challenge: { findUnique: mockDbReadChallengeFindUnique },
  },
  dbWrite: {
    $queryRaw: mockDbWriteQueryRaw,
    $executeRaw: mockDbWriteExecuteRaw,
    challenge: { update: mockDbWriteChallengeUpdate, findUnique: mockDbWriteChallengeFindUnique },
  },
}));

vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/flipt/client')>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(false) };
});

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async () => {
  const real = await import('~/server/games/daily-challenge/daily-challenge-scoring');
  return {
    SCORE_WEIGHTS: real.SCORE_WEIGHTS,
    calculateWeightedScore: real.calculateWeightedScore,
    challengeToLegacyFormat: vi.fn(),
    deriveChallengeNsfwLevel: vi.fn(() => 1),
    endChallenge: mockEndChallenge,
    getActiveChallenges: mockGetActiveChallenges,
    getChallengeConfig: mockGetChallengeConfig,
    getJudgingConfig: mockGetJudgingConfig,
    getUpcomingSystemChallenge: vi.fn(),
  };
});

vi.mock('~/server/games/daily-challenge/challenge-helpers', () => ({
  challengeClaimStillHeld: vi.fn().mockResolvedValue(true),
  completeChallengeIfClaimHeld: vi.fn().mockResolvedValue(true),
  claimChallengeForCompletion: mockClaimChallengeForCompletion,
  computeDynamicPool: vi.fn(),
  distributePrizes: vi.fn(),
  createChallengeRecord: vi.fn(),
  createChallengeWinner: mockCreateChallengeWinner,
  getChallengeById: mockGetChallengeById,
  getChallengeEntryCount: vi.fn().mockResolvedValue(0),
  getExistingWinnersForRetry: mockGetExistingWinnersForRetry,
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  resolveEventContext: mockResolveEventContext,
  setChallengeActive: vi.fn(),
  updateChallengeStatus: mockUpdateChallengeStatus,
}));

vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateArticle: vi.fn(),
  generateCollectionDetails: vi.fn(),
  generateReview: vi.fn(),
  generateWinners: mockGenerateWinners,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: vi.fn().mockResolvedValue(undefined),
  getTransactionByExternalId: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/services/commentsv2.service', () => ({
  upsertComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
  buildWinnerPayoutTransactions: vi.fn().mockReturnValue([]),
  getChallengeBuzzType: vi.fn().mockResolvedValue('user'),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: mockLogToAxiom,
}));

const { pickWinnersForChallenge } = await import('~/server/jobs/daily-challenge-processing');
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

const BASE_CONFIG = {
  challengeType: 'world-morph',
  challengeCollectionId: 1,
  judgedTagId: 11,
  reviewMeTagId: 12,
  userCooldown: '14 day',
  resourceCooldown: '90 day',
  winnerCooldown: '7 day',
  prizes: [],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
  reviewAmount: { min: 6, max: 12 },
  maxScoredPerUser: 5,
  finalReviewAmount: 10,
  resourceCosmeticId: null,
  articleTagId: 1,
  defaultJudgeId: 1,
  defaultJudge: null,
} as never;

const JUDGING_CONFIG = {
  judgeId: 1,
  userId: 999,
  sourceCollectionId: null,
  prompts: {},
  reviewTemplate: null,
} as never;

const PRIZES = [
  { buzz: 500, points: 10 },
  { buzz: 250, points: 5 },
  { buzz: 100, points: 2 },
];

const currentChallenge = {
  challengeId: 1,
  type: 'daily',
  date: new Date(),
  theme: 'test',
  modelId: 1,
  modelVersionIds: [1],
  collectionId: 100,
  title: 'Test',
  invitation: '',
  coverUrl: '',
  prizes: PRIZES,
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
} as never;

function mockChallengeJudgeRow(source: string) {
  mockDbReadQueryRaw.mockResolvedValueOnce([
    { judgeId: null, judgingPrompt: null, eventId: null, source, judgingCategories: null },
  ]);
}

function mockJudgedEntryRows(
  rows: Array<{
    imageId: number;
    userId: number;
    username: string;
    score?: { theme: number; aesthetic: number; humor: number; wittiness: number };
  }>
) {
  mockDbReadQueryRaw.mockResolvedValueOnce(
    rows.map((row) => ({
      imageId: row.imageId,
      userId: row.userId,
      username: row.username,
      note: JSON.stringify({
        score: row.score ?? { theme: 10, aesthetic: 8, humor: 8, wittiness: 8 },
        summary: `entry by ${row.username}`,
      }),
    }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWriteExecuteRaw.mockResolvedValue(1);
  mockGetChallengeConfig.mockResolvedValue(BASE_CONFIG);
  mockGetJudgingConfig.mockResolvedValue(JUDGING_CONFIG);
  mockEndChallenge.mockResolvedValue(undefined);
  mockClaimChallengeForCompletion.mockResolvedValue(true);
  mockGetExistingWinnersForRetry.mockResolvedValue([]);
  mockResolveEventContext.mockResolvedValue(undefined);
  mockUpdateChallengeStatus.mockResolvedValue(undefined);
  mockRefundUserChallengeFunds.mockResolvedValue({ refundedEntries: 0 });
  mockDbWriteChallengeFindUnique.mockResolvedValue({ prizePool: 0, prizeDistribution: null });
  // Resolve to the PERSISTED row (fresh insert), the real return shape. Resolving `1` here left
  // every caller's `reconcileWinnerToPersisted` on its degrade path — see persisted-winner.fixture.
  mockCreateChallengeWinner.mockImplementation(
    async (input: { place: number; buzzAwarded: number; pointsAwarded?: number }) =>
      freshPersistedWinner(input)
  );
  mockGetChallengeById.mockResolvedValue(null);
});

describe('pickWinnersForChallenge winner mapping (name-spoof hardening)', () => {
  it('maps each LLM winner to the correct entry by creatorId even when display names collide', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    // Two distinct entrants sharing the SAME display name ("Alice") — entry 100 outscores entry
    // 200, so entry 100 sorts first in judgedEntries. The LLM (per creatorId) actually chose the
    // lower-scored entrant (200) for 1st place and the higher-scored entrant (100) for 2nd — a
    // name-based (or name-OR-id) match would resolve BOTH winners to whichever entry happens to
    // come first in array order, since both share the spoofed name.
    mockJudgedEntryRows([
      {
        imageId: 1,
        userId: 100,
        username: 'Alice',
        score: { theme: 10, aesthetic: 10, humor: 10, wittiness: 10 },
      },
      {
        imageId: 2,
        userId: 200,
        username: 'Alice',
        score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
      },
    ]);
    // Global winner-cooldown query (System source, no event context) — nobody excluded.
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);

    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'Alice', creatorId: 200, reason: 'best' },
        { creator: 'Alice', creatorId: 100, reason: 'second' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
    expect(mockCreateChallengeWinner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 200,
        imageId: 2,
        place: 1,
        buzzAwarded: 500,
        reason: 'best',
      })
    );
    expect(mockCreateChallengeWinner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: 100,
        imageId: 1,
        place: 2,
        buzzAwarded: 250,
        reason: 'second',
      })
    );
  });
});

// Challenge 390 was recorded with winners at places 2 and 3 and nothing at place 1: its 5,000 Buzz
// and 150 points reached nobody and the challenge page rendered no first place. The pick that should
// have been 1st resolved to no entry, and because placement came from the pick's index in the LLM's
// array before the unresolvable ones were filtered out, the survivors kept slots 2 and 3 instead of
// moving up. `resolveWinnerPicks` is unit-tested on its own; these drive the same thing through
// `pickWinnersForChallenge`, so reverting the CALL SITE back to `position: i + 1` fails here.
describe('pickWinnersForChallenge unmatched picks (challenge 390)', () => {
  it("awards places 1 and 2 when the judge's first pick resolves to no entry", async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([
      { imageId: 1, userId: 100, username: 'Alice' },
      { imageId: 2, userId: 200, username: 'Bob' },
    ]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);

    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'Nobody', creatorId: 999999, reason: 'first' },
        { creator: 'Alice', creatorId: 100, reason: 'second' },
        { creator: 'Bob', creatorId: 200, reason: 'third' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(2);
    // Places close up, and the prize follows the place they are actually recorded at — the top prize
    // is awarded rather than left in account 0 as it was on 390.
    expect(mockCreateChallengeWinner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 100, place: 1, buzzAwarded: 500, pointsAwarded: 10 })
    );
    expect(mockCreateChallengeWinner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ userId: 200, place: 2, buzzAwarded: 250, pointsAwarded: 5 })
    );
  });

  it('reports the unfilled prize on a System challenge, which used to be exempt', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([
      { imageId: 1, userId: 100, username: 'Alice' },
      { imageId: 2, userId: 200, username: 'Bob' },
    ]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockGetChallengeById.mockResolvedValue({
      source: ChallengeSource.System,
      prizes: PRIZES,
      metadata: null,
    });

    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      winners: [
        { creator: 'Alice', creatorId: 100, reason: 'first' },
        { creator: 'Nobody', creatorId: 999999, reason: 'second' },
        { creator: 'Nobody either', creatorId: 888888, reason: 'third' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // Two funded places reached nobody. Re-gating this on `source === User` makes a daily challenge
    // silent again, which is how 390 went unnoticed until a user reported it.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-partial-winner-residual',
        source: ChallengeSource.System,
        residualBuzz: 350,
        winnersCount: 1,
        prizePlaces: 3,
      })
    );
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-winner-unmatched-pick',
        unmatchedIndexes: [1, 2],
      })
    );
  });

  it('resolves a creatorId the judge returned as a numeric string', async () => {
    mockChallengeJudgeRow(ChallengeSource.System);
    mockJudgedEntryRows([{ imageId: 1, userId: 100, username: 'Alice' }]);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);

    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm-picked',
      model: 'test-model',
      usage: {},
      // Strict `===` against a number rejected this, and the judge playground could not surface it:
      // it renders the model's `creator` name and never resolves the id at all.
      winners: [{ creator: 'Alice', creatorId: '100', reason: 'first' }],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockCreateChallengeWinner).toHaveBeenCalledTimes(1);
    expect(mockCreateChallengeWinner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ userId: 100, imageId: 1, place: 1, buzzAwarded: 500 })
    );
  });
});

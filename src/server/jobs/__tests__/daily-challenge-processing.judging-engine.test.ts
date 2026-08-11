import { describe, it, expect, vi, beforeEach } from 'vitest';
import { freshPersistedWinner } from '~/server/games/daily-challenge/__tests__/persisted-winner.fixture';
import type * as EngineRegistry from '~/server/games/daily-challenge/challenge-engine-registry';
import type * as Flipt from '~/server/flipt/client';

// Where the judging engine meets the job. Two things are load-bearing and neither is visible from
// the engine's own unit tests: an entry the absolute pass disqualified must never reach the
// engine, and an engine that ranks the field must be the thing that picks the places.
//
// Mocking mirrors challenge-degenerate-winners.test.ts — the same module boundary, so the ranking
// math and the payout path under test are the real ones.

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
  mockGenerateReview,
  mockGenerateWinners,
  mockClaimChallengeForCompletion,
  mockGetExistingWinnersForRetry,
  mockResolveEventContext,
  mockUpdateChallengeStatus,
  mockRefundUserChallengeFunds,
  mockCreateChallengeWinner,
  mockGetChallengeById,
  mockResolveJudgingEngine,
  mockRecordEntry,
  mockRankField,
  mockSelectWinners,
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
  mockGenerateReview: vi.fn(),
  mockGenerateWinners: vi.fn(),
  mockClaimChallengeForCompletion: vi.fn().mockResolvedValue(true),
  mockGetExistingWinnersForRetry: vi.fn().mockResolvedValue([]),
  mockResolveEventContext: vi.fn().mockResolvedValue(undefined),
  mockUpdateChallengeStatus: vi.fn().mockResolvedValue(undefined),
  mockRefundUserChallengeFunds: vi.fn().mockResolvedValue({ refundedEntries: 0 }),
  mockCreateChallengeWinner: vi.fn(),
  mockGetChallengeById: vi.fn().mockResolvedValue(null),
  mockResolveJudgingEngine: vi.fn(),
  mockRecordEntry: vi.fn().mockResolvedValue(undefined),
  mockRankField: vi.fn(),
  mockSelectWinners: vi.fn().mockResolvedValue(null),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: {
    $queryRaw: mockDbReadQueryRaw,
    challenge: { findUnique: mockDbReadChallengeFindUnique },
  },
  dbWrite: {
    $queryRaw: mockDbWriteQueryRaw,
    $executeRaw: mockDbWriteExecuteRaw,
    $executeRawUnsafe: mockDbWriteExecuteRaw,
    challenge: { update: mockDbWriteChallengeUpdate, findUnique: mockDbWriteChallengeFindUnique },
  },
}));

vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof Flipt>();
  return { ...actual, isFlipt: vi.fn().mockResolvedValue(true) };
});

// Only `resolveJudgingEngine` is replaced; `buildJudgingEngineContext` stays real so the rubric
// the job hands the engine is the one production builds.
vi.mock('~/server/games/daily-challenge/challenge-engine-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof EngineRegistry>()),
  resolveJudgingEngine: mockResolveJudgingEngine,
}));

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
  generateReview: mockGenerateReview,
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
  createNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  refundUserChallengeFunds: mockRefundUserChallengeFunds,
  buildWinnerPayoutTransactions: vi.fn().mockReturnValue([]),
  getChallengeBuzzType: vi.fn().mockResolvedValue('yellow'),
  reportPoolFundingShortfall: vi.fn(),
}));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const { pickWinnersForChallenge, reviewEntries } = await import(
  '~/server/jobs/daily-challenge-processing'
);
const { ChallengeSource } = await import('~/shared/utils/prisma/enums');

/** Mirrors BASE_CONFIG below, which is cast to `never` and so cannot be read back. */
const FINAL_REVIEW_AMOUNT = 10;

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
  prizes: [
    { buzz: 500, points: 10 },
    { buzz: 250, points: 5 },
    { buzz: 100, points: 2 },
  ],
  entryPrizeRequirement: 10,
  entryPrize: { buzz: 0, points: 0 },
} as never;

const engine = {
  key: 'pairwise-ladder' as const,
  ranksFullField: true,
  recordEntry: mockRecordEntry,
  rankField: mockRankField,
  selectWinners: mockSelectWinners,
};

/** Drives one reviewEntries() pass over a single entry with the given absolute-pass score. */
function mockReviewSequence(score: Record<string, number>) {
  mockGetActiveChallenges.mockResolvedValue([currentChallenge]);
  mockDbReadQueryRaw
    .mockResolvedValueOnce([
      {
        allowedNsfwLevel: 1,
        judgeId: null,
        judgingPrompt: null,
        prizeMode: 'Fixed',
        prizePool: 0,
        basePrizePool: 0,
        buzzPerAction: 0,
        poolTrigger: null,
        maxPrizePool: null,
        prizeDistribution: null,
        metadata: null,
        source: ChallengeSource.System,
        judgingCategories: null,
        entryFee: 0,
        judgingEngine: 'pairwise-ladder',
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  mockDbReadChallengeFindUnique.mockResolvedValue({ reviewCostType: 'None', reviewCost: 0 });
  mockDbWriteQueryRaw
    .mockResolvedValueOnce([]) // userScoredCounts
    .mockResolvedValueOnce([
      { imageId: 1, userId: 100, username: 'alice', url: 'uuid-1', nsfwLevel: 4 },
    ]) // recentEntries
    .mockResolvedValueOnce([]) // requestReview
    .mockResolvedValueOnce([{ exists: false }]) // alreadyReviewed guard
    .mockResolvedValueOnce([]); // earnedPrizes
  mockGenerateReview.mockResolvedValue({
    score,
    summary: 'summary',
    comment: 'nice',
    reaction: 'Like',
  });
}

function mockJudgedEntryRows(rows: { imageId: number; userId: number; username: string }[]) {
  mockDbReadQueryRaw.mockResolvedValueOnce(
    rows.map((row) => ({
      ...row,
      note: JSON.stringify({
        score: { theme: 10, aesthetic: 8, humor: 8, wittiness: 8 },
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
  mockGetChallengeById.mockResolvedValue(null);
  mockCreateChallengeWinner.mockImplementation(
    async (input: { place: number; buzzAwarded: number; pointsAwarded?: number }) =>
      freshPersistedWinner(input)
  );
  mockResolveJudgingEngine.mockResolvedValue(engine);
  mockRankField.mockImplementation(async (_ctx: unknown, field: unknown[]) => field);
  mockSelectWinners.mockResolvedValue(null);
});

describe('reviewEntries — handing an entry to the engine', () => {
  it('records a judged entry, with the nsfwLevel the pair routing needs', async () => {
    mockReviewSequence({ theme: 8, aesthetic: 8, humor: 8, wittiness: 8 });

    await reviewEntries();

    expect(mockRecordEntry).toHaveBeenCalledTimes(1);
    expect(mockRecordEntry.mock.calls[0][1]).toEqual({
      imageId: 1,
      userId: 100,
      username: 'alice',
      url: 'uuid-1',
      nsfwLevel: 4,
    });
  });

  it('does NOT record an entry the theme gate disqualified', async () => {
    // theme <= 2 is an absolute judgement about one image. A comparison cannot express it, so a
    // disqualified entry must not become a rung that other entries are measured against.
    mockReviewSequence({ theme: 1, aesthetic: 10, humor: 10, wittiness: 10 });

    await reviewEntries();

    expect(mockGenerateReview).toHaveBeenCalledTimes(1);
    expect(mockRecordEntry).not.toHaveBeenCalled();
  });

  it('still writes the note and the comment for a disqualified entry', async () => {
    mockReviewSequence({ theme: 1, aesthetic: 10, humor: 10, wittiness: 10 });

    await reviewEntries();

    const noteWrite = mockDbWriteExecuteRaw.mock.calls.find((call) =>
      (call[0] as unknown as string[]).join('').includes('UPDATE "CollectionItem"')
    );
    expect(noteWrite).toBeDefined();
  });
});

describe('pickWinnersForChallenge — who picks the places', () => {
  function mockJudgeRow(judgingEngine: string) {
    mockDbReadQueryRaw.mockResolvedValueOnce([
      {
        judgeId: null,
        judgingPrompt: null,
        eventId: null,
        source: ChallengeSource.System,
        judgingCategories: null,
        judgingEngine,
        metadata: null,
      },
    ]);
  }

  const entries = [
    { imageId: 1, userId: 100, username: 'alice' },
    { imageId: 2, userId: 200, username: 'bob' },
    { imageId: 3, userId: 300, username: 'carol' },
  ];

  it("pays out the engine's places, not the LLM's picks", async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(entries);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]); // winner cooldown
    mockSelectWinners.mockResolvedValue([
      { userId: 300, imageId: 3, reason: 'won the round-robin' },
      { userId: 100, imageId: 1, reason: 'second on win rate' },
    ]);
    mockGenerateWinners.mockResolvedValue({
      process: 'recap',
      outcome: 'recap',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [
        { creatorId: 200, creator: 'bob', reason: 'llm pick' },
        { creatorId: 100, creator: 'alice', reason: 'llm pick' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    const places = mockCreateChallengeWinner.mock.calls.map((call) => call[0]);
    expect(places.map((p: { userId: number }) => p.userId)).toEqual([300, 100]);
    expect(places[0]).toMatchObject({ place: 1, buzzAwarded: 500, reason: 'won the round-robin' });
    expect(places[1]).toMatchObject({ place: 2, buzzAwarded: 250 });
  });

  it('still writes the recap the LLM produced', async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(entries);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue([{ userId: 300, imageId: 3, reason: 'won' }]);
    mockGenerateWinners.mockResolvedValue({
      process: 'how I judged',
      outcome: 'what happened',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockGenerateWinners).toHaveBeenCalledTimes(1);
    const update = mockDbWriteChallengeUpdate.mock.calls.at(-1)?.[0] as {
      data: { metadata: { completionSummary: { judgingProcess: string; outcome: string } } };
    };
    expect(update.data.metadata.completionSummary).toMatchObject({
      judgingProcess: 'how I judged',
      outcome: 'what happened',
    });
  });

  it('leaves the LLM winner pick in charge when the engine has no opinion', async () => {
    // The legacy path. An engine returning null must change nothing about who gets paid.
    mockJudgeRow('legacy-absolute');
    mockJudgedEntryRows(entries);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [
        { creatorId: 200, creator: 'bob', reason: 'llm pick' },
        { creatorId: 100, creator: 'alice', reason: 'llm pick' },
      ],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    const places = mockCreateChallengeWinner.mock.calls.map((call) => call[0]);
    expect(places.map((p: { userId: number }) => p.userId)).toEqual([200, 100]);
    expect(places[0]).toMatchObject({ reason: 'llm pick' });
  });

  it('ranks the field before anything is paid', async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(entries);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockRankField.mockImplementation(async (_ctx: unknown, field: { imageId: number }[]) =>
      [...field].reverse()
    );
    mockSelectWinners.mockResolvedValue(null);
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [{ creatorId: 100, creator: 'alice', reason: 'llm pick' }],
    });

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockRankField).toHaveBeenCalledTimes(1);
    const recapEntries = mockGenerateWinners.mock.calls[0][0].entries as { creatorId: number }[];
    const rankedIds = (await mockRankField.mock.results[0].value).map(
      (entry: { userId: number }) => entry.userId
    );
    expect(recapEntries.map((entry) => entry.creatorId)).toEqual(rankedIds);
  });

  // The absolute cut used to happen BEFORE the engine saw anything: getJudgedEntries sorts by the
  // absolute weighted score with a `Math.random()` tiebreak and slices to finalReviewAmount. An
  // engine that ranks by comparison would then be reordering ten entries the coin flip had already
  // chosen — the ranking replaced by the very mechanism it exists to replace.
  function wideField(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      imageId: i + 1,
      userId: (i + 1) * 100,
      username: `u${i + 1}`,
    }));
  }

  function recapOnly() {
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [],
    });
  }

  it('hands a comparison engine the WHOLE eligible field, not the absolute-score top ten', async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(wideField(24));
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect((mockRankField.mock.calls[0][1] as unknown[]).length).toBe(24);
  });

  it('keeps the historical cut for an engine that does not rank the field', async () => {
    mockResolveJudgingEngine.mockResolvedValue({ ...engine, ranksFullField: false });
    mockJudgeRow('legacy-absolute');
    mockJudgedEntryRows(wideField(24));
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect((mockRankField.mock.calls[0][1] as unknown[]).length).toBe(FINAL_REVIEW_AMOUNT);
  });

  it('gives the podium the full ranking but the recap only the top N', async () => {
    // finalReviewAmount is 10 and the podium shortlists 15, so slicing before `selectWinners`
    // would silently cap the round-robin below its own shortlist size.
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(wideField(24));
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect((mockSelectWinners.mock.calls[0][1] as unknown[]).length).toBe(24);
    expect((mockGenerateWinners.mock.calls[0][0].entries as unknown[]).length).toBe(
      FINAL_REVIEW_AMOUNT
    );
  });

  it('lets a coverage failure abort the payout rather than paying a subset', async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(entries);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockRankField.mockRejectedValue(new Error('standings cover 2 of 3 eligible entries'));

    await expect(pickWinnersForChallenge(currentChallenge, BASE_CONFIG)).rejects.toThrow(
      /cover 2 of 3/
    );
    expect(mockCreateChallengeWinner).not.toHaveBeenCalled();
    expect(mockUpdateChallengeStatus).not.toHaveBeenCalled();
  });
});

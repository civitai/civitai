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
  dedupesAfterRanking: true,
  shortlistSize: 15,
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
    mockResolveJudgingEngine.mockResolvedValue({
      ...engine,
      ranksFullField: false,
      shortlistSize: 0,
    });
    mockJudgeRow('legacy-absolute');
    mockJudgedEntryRows(wideField(24));
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect((mockRankField.mock.calls[0][1] as unknown[]).length).toBe(FINAL_REVIEW_AMOUNT);
    // A legacy engine has no shortlist, so the recap still gets exactly the historical cut.
    expect((mockGenerateWinners.mock.calls[0][0].entries as unknown[]).length).toBe(
      FINAL_REVIEW_AMOUNT
    );
  });

  it('gives the podium the full ranking and the recap at least the shortlist', async () => {
    // finalReviewAmount is 10 and the podium shortlists 15, so slicing before `selectWinners`
    // would silently cap the round-robin below its own shortlist size — and a recap fed only the
    // top 10 could not describe a winner the podium promoted from rank 11-15.
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(wideField(24));
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect((mockSelectWinners.mock.calls[0][1] as unknown[]).length).toBe(24);
    expect((mockGenerateWinners.mock.calls[0][0].entries as unknown[]).length).toBe(15);
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

// The property Justin asked for: a user's representative must be chosen by the measure we are
// actually ranking with. Before this, `getJudgedEntries` picked it by absolute weighted score with
// a Math.random() tiebreak and handed the engine 64 representatives out of 285 — so the coin flip
// this engine exists to remove still ran, one level upstream, and pairwise never saw the other 221.
//
// EVERY entry here belongs to a user who has another one. A fixture with one entry per user makes
// the dedupe a no-op and would pass whichever measure picked the representative.
describe('pickWinnersForChallenge — a user’s representative comes from the ladder, not the score', () => {
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

  function recapOnly() {
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [],
    });
  }

  /** `aesthetic` is the only score that moves, so the absolute order is exactly its descending order. */
  function mockScoredRows(
    rows: { imageId: number; userId: number; username: string; aesthetic: number }[]
  ) {
    mockDbReadQueryRaw.mockResolvedValueOnce(
      rows.map(({ aesthetic, ...row }) => ({
        ...row,
        note: JSON.stringify({
          score: { theme: 10, aesthetic, humor: 8, wittiness: 8 },
          summary: `entry by ${row.username}`,
        }),
      }))
    );
  }

  // alice's absolute-best is image 1; bob's is image 2. The ladder disagrees about both.
  const FIELD = [
    { imageId: 1, userId: 100, username: 'alice', aesthetic: 10 },
    { imageId: 4, userId: 100, username: 'alice', aesthetic: 2 },
    { imageId: 2, userId: 200, username: 'bob', aesthetic: 9 },
    { imageId: 5, userId: 200, username: 'bob', aesthetic: 3 },
  ];

  /** Ladder order, deliberately the reverse of the absolute order within each user. */
  function rankAs(order: number[]) {
    mockRankField.mockImplementation(async (_ctx: unknown, field: { imageId: number }[]) =>
      order.map((id) => field.find((entry) => entry.imageId === id)!)
    );
  }

  function imageIdsOf(value: unknown) {
    return (value as { imageId: number }[]).map((entry) => entry.imageId);
  }

  it('hands the engine every entry, including the second one from the same user', async () => {
    mockJudgeRow('pairwise-ladder');
    mockScoredRows(FIELD);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(imageIdsOf(mockRankField.mock.calls[0][1]).sort()).toEqual([1, 2, 4, 5]);
  });

  it('takes each user’s BEST BY LADDER RANK, not their best by absolute score', async () => {
    mockJudgeRow('pairwise-ladder');
    mockScoredRows(FIELD);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    // Both users' weaker absolute entry wins on the ladder.
    rankAs([4, 5, 1, 2]);
    mockSelectWinners.mockResolvedValue([{ userId: 100, imageId: 4, reason: 'ladder' }]);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // 4 and 5 are the ladder-best; 1 and 2 are the absolute-best. Picking by score gives [1, 2].
    expect(imageIdsOf(mockSelectWinners.mock.calls[0][1])).toEqual([4, 5]);
  });

  it('keeps one entry per user — the podium must not play a user against themselves', async () => {
    mockJudgeRow('pairwise-ladder');
    mockScoredRows(FIELD);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    rankAs([4, 1, 5, 2]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // 4 then 1 are both alice's; the ladder-first one survives and the recap sees no duplicate.
    expect(imageIdsOf(mockSelectWinners.mock.calls[0][1])).toEqual([4, 5]);
    const recapCreators = (
      mockGenerateWinners.mock.calls[0][0].entries as { creatorId: number }[]
    ).map((entry) => entry.creatorId);
    expect(recapCreators).toEqual([...new Set(recapCreators)]);
  });

  it('leaves legacy deduping before the ranking, by absolute score, exactly as it was', async () => {
    mockResolveJudgingEngine.mockResolvedValue({
      ...engine,
      key: 'legacy-absolute',
      ranksFullField: false,
      dedupesAfterRanking: false,
      shortlistSize: 0,
    });
    mockJudgeRow('legacy-absolute');
    mockScoredRows(FIELD);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    // Pre-deduped to the absolute-best per user, before the engine ever sees the field.
    expect(imageIdsOf(mockRankField.mock.calls[0][1]).sort()).toEqual([1, 2]);
  });
});

// Arrival placement is read-modify-write — getStandings, findSlot, insertStanding — with nothing
// serialising it. Run inside the concurrent review tasks, every entry in a tick binary-searches the
// SAME standings snapshot, so none of them ever meets another. Measured live on a 6-entry
// challenge: every arrival bout was against the first entry placed, 0/1/1/1/1/1 comparisons where
// serial placement costs ~11 across different incumbents.
//
// It is invisible from outside — the standings look complete and `comparisons` records the small
// number — and at small field sizes the close-time rerun repairs it, which is why the live test
// still passed. On a 284-entry field the rerun is bounded at K and the rest keep the burst's answer.
//
// Same failure shape as the podium seat race: an instantly-resolving mock cannot see it, so the
// fake below puts a real await between the read and the write.
describe('reviewEntries — entries in one tick are placed against each other, not one pivot', () => {
  const ENTRIES = 5;

  /** Stateful stand-in for the ladder: reads the standings, "compares", then appends. */
  function ladderFake() {
    const ladder: number[] = [];
    const opponents: number[] = [];

    mockRecordEntry.mockImplementation(async (_ctx: unknown, entry: { imageId: number }) => {
      const snapshot = [...ladder];
      // The await that makes the read-modify-write interleavable — a synchronous fake cannot
      // express the bug this test exists to catch.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (snapshot.length) opponents.push(snapshot[snapshot.length >> 1]);
      ladder.push(entry.imageId);
    });

    return { ladder, opponents };
  }

  function mockMultiEntryReview(count: number) {
    const entries = Array.from({ length: count }, (_, i) => ({
      imageId: 100 + i,
      userId: 1000 + i,
      username: `u${i}`,
      url: `uuid-${i}`,
      nsfwLevel: 1,
    }));

    mockGetActiveChallenges.mockResolvedValue([currentChallenge]);
    mockDbReadQueryRaw.mockResolvedValue([
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
    ]);
    mockDbReadChallengeFindUnique.mockResolvedValue({ reviewCostType: 'None', reviewCost: 0 });

    // Keyed off the SQL rather than call order: five entries at concurrency 5 interleave their
    // per-entry guard query, so a mockResolvedValueOnce chain would hand back the wrong rows.
    mockDbWriteQueryRaw.mockImplementation(async (strings: unknown) => {
      const sql = (strings as string[]).join(' ');
      if (sql.includes('SELECT EXISTS')) return [{ exists: false }];
      // `tagId IS NULL` is the recent-entry query; the request-review query filters on
      // `tagId = reviewMeTagId` and must stay empty or every entry is reviewed twice.
      if (sql.includes('ci."tagId" IS NULL')) return entries;
      return [];
    });

    mockGenerateReview.mockResolvedValue({
      score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
      summary: 'summary',
      comment: 'nice',
      reaction: 'Like',
    });

    return entries;
  }

  it('never lets two placements overlap', async () => {
    mockMultiEntryReview(ENTRIES);
    let inFlight = 0;
    let peak = 0;
    mockRecordEntry.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    await reviewEntries();

    expect(mockRecordEntry).toHaveBeenCalledTimes(ENTRIES);
    expect(peak).toBe(1);
  });

  it('measures each arrival against a DIFFERENT incumbent, not all against the first', async () => {
    mockMultiEntryReview(ENTRIES);
    const { opponents } = ladderFake();

    await reviewEntries();

    // The bug's signature: 4 opponents, every one of them the first entry placed.
    expect(opponents).toHaveLength(ENTRIES - 1);
    expect(new Set(opponents).size).toBeGreaterThan(1);
  });

  it('places in submission order, not in the order the LLM calls happened to return', async () => {
    mockMultiEntryReview(ENTRIES);

    // The absolute pass stays concurrent, so completion order is whatever the provider does. Skew
    // it hard the other way: the first entry started is the last one finished.
    const started: number[] = [];
    const finished: number[] = [];
    mockGenerateReview.mockImplementation(async (input: { creator: string }) => {
      const imageId = 100 + Number(input.creator.slice(1));
      started.push(imageId);
      const rank = started.length;
      await new Promise((resolve) => setTimeout(resolve, (ENTRIES - rank + 1) * 10));
      finished.push(imageId);
      return {
        score: { theme: 8, aesthetic: 8, humor: 8, wittiness: 8 },
        summary: 'summary',
        comment: 'nice',
        reaction: 'Like',
      };
    });

    const placed: number[] = [];
    mockRecordEntry.mockImplementation(async (_ctx: unknown, entry: { imageId: number }) => {
      placed.push(entry.imageId);
    });

    await reviewEntries();

    expect(placed).toEqual(started);
    // Without this the test would pass on a fake whose completion order matched anyway.
    expect(finished).not.toEqual(started);
  });
});

// The other half of the recap fix: generateWinners can only write about the right people if the
// caller hands it the engine's places. See challenge-recap-winners.test.ts for the prompt side.
describe('pickWinnersForChallenge — the recap writer is told who actually won', () => {
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

  const field = [
    { imageId: 1, userId: 100, username: 'Vince_AI' },
    { imageId: 2, userId: 200, username: 'ArtisticSoul66' },
    { imageId: 3, userId: 300, username: 'unexpectedlyprovided' },
  ];

  function recapOnly() {
    mockGenerateWinners.mockResolvedValue({
      process: 'llm',
      outcome: 'llm',
      model: 'test-model',
      usage: { promptTokens: 0, completionTokens: 0 },
      winners: [],
    });
  }

  it('passes the engine’s places, in place order, with the right names', async () => {
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(field);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue([
      { userId: 100, imageId: 1, reason: 'won the round-robin' },
      { userId: 200, imageId: 2, reason: 'second on win rate' },
    ]);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockGenerateWinners.mock.calls[0][0].decidedWinners).toEqual([
      { creatorId: 100, creator: 'Vince_AI', place: 1, reason: 'won the round-robin' },
      { creatorId: 200, creator: 'ArtisticSoul66', place: 2, reason: 'second on win rate' },
    ]);
  });

  it('leaves the recap writer picking for itself when the engine has no opinion', async () => {
    mockJudgeRow('legacy-absolute');
    mockJudgedEntryRows(field);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue(null);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    expect(mockGenerateWinners.mock.calls[0][0].decidedWinners).toBeUndefined();
  });

  it('gives the recap a summary for every creator it is told won', async () => {
    // An engine winner outside the recap shortlist would otherwise leave the model writing prose
    // about a creator whose entry it was never shown.
    mockJudgeRow('pairwise-ladder');
    mockJudgedEntryRows(field);
    mockDbWriteQueryRaw.mockResolvedValueOnce([]);
    mockSelectWinners.mockResolvedValue([{ userId: 300, imageId: 3, reason: 'won' }]);
    recapOnly();

    await pickWinnersForChallenge(currentChallenge, BASE_CONFIG);

    const call = mockGenerateWinners.mock.calls[0][0];
    const known = new Set((call.entries as { creatorId: number }[]).map((e) => e.creatorId));
    for (const winner of call.decidedWinners as { creatorId: number }[]) {
      expect(known.has(winner.creatorId)).toBe(true);
    }
  });
});

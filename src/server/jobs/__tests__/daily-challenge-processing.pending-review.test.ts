import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EngineRegistry from '~/server/games/daily-challenge/challenge-engine-registry';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import type * as DailyChallengeUtils from '~/server/games/daily-challenge/daily-challenge.utils';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import type * as Flipt from '~/server/flipt/client';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import '~/__tests__/mocks/logging.mock';

const { mockGenerateReview, mockWriteJudgeComment, mockGetActiveChallenges, mockSaveReviewState } =
  vi.hoisted(() => ({
    mockSaveReviewState: vi.fn(),
    mockGenerateReview: vi.fn(),
    mockWriteJudgeComment: vi.fn(),
    mockGetActiveChallenges: vi.fn(),
  }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: vi.fn().mockResolvedValue(true),
}));
vi.mock('~/server/games/daily-challenge/challenge-engine-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof EngineRegistry>()),
  resolveJudgingEngine: vi.fn().mockResolvedValue({ key: 'absolute', recordEntry: vi.fn() }),
}));
vi.mock('~/server/games/daily-challenge/daily-challenge.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof DailyChallengeUtils>()),
  getActiveChallenges: mockGetActiveChallenges,
  getChallengeConfig: vi.fn().mockResolvedValue({
    judgedTagId: 11,
    reviewMeTagId: 12,
    reviewAmount: { min: 6, max: 12 },
    maxScoredPerUser: 5,
    defaultJudgeId: 1,
    defaultJudge: null,
  }),
  getJudgingConfig: vi.fn().mockResolvedValue({ judgeId: 1, userId: 999, prompts: {} }),
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeHelpers>()),
  incrementOperationSpent: vi.fn().mockResolvedValue(undefined),
  saveReviewState: mockSaveReviewState,
}));
vi.mock('~/server/games/daily-challenge/challenge-rewards', () => ({
  distributeParticipationPrizes: vi.fn().mockResolvedValue([]),
  refundBannedEntrantReviews: vi.fn().mockResolvedValue([]),
  promoteChallengeEntries: vi.fn().mockResolvedValue(0),
}));
vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  estimateBuzzCost: vi.fn().mockReturnValue(0),
  generateReview: mockGenerateReview,
}));
vi.mock('~/server/services/commentv3/comment-write.service', () => ({
  writeJudgeComment: mockWriteJudgeComment,
}));
vi.mock('~/server/services/reaction.service', () => ({
  toggleReaction: vi.fn().mockResolvedValue('created'),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/events', () => ({
  eventEngine: { processEngagement: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

const {
  reviewEntries,
  settlePendingReview,
  MAX_PENDING_REVIEW_ATTEMPTS,
  MAX_OWED_REVIEWS_PER_TICK,
} = await import('~/server/jobs/daily-challenge-processing');

const entry = (imageId: number) => ({
  imageId,
  userId: imageId * 10,
  username: `user${imageId}`,
  url: `uuid-${imageId}`,
  nsfwLevel: 1,
});
const review = { score: { theme: 8 }, summary: 's', comment: 'nice', reaction: 'Like' };

/**
 * One review tick. `rows` answers the job's dbWrite reads by the table or clause each one names,
 * so a new read elsewhere in the tick does not shift what these cases are fed.
 */
function tick({
  pendingReview,
  sampled = [],
  pending = [],
}: {
  pendingReview?: Record<string, number>;
  sampled?: ReturnType<typeof entry>[];
  pending?: ReturnType<typeof entry>[];
}) {
  mockGetActiveChallenges.mockResolvedValue([
    { challengeId: 1, collectionId: 100, date: new Date(), theme: 't', modelVersionIds: [] },
  ]);
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (strings: string[]) => {
    const sql = strings.join('?');
    if (sql.includes('"judgingEngine"'))
      return [
        {
          allowedNsfwLevel: 1,
          judgeId: null,
          metadata: pendingReview ? { pendingReview } : null,
          source: ChallengeSource.System,
          entryFee: 0,
          prizeMode: 'Fixed',
        },
      ];
    return [];
  }) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: string[]) => {
    const sql = strings.join('?');
    if (sql.includes('"imageId" = ANY(')) return pending;
    if (sql.includes('ci."tagId" IS NULL')) return sampled;
    if (sql.includes('AS "exists"')) return [{ exists: false }];
    return [];
  }) as never);
}

/** What the tick settled on Challenge.metadata: removed keys and the retry object. */
function metadataWrite() {
  expect(mockSaveReviewState).toHaveBeenCalledTimes(1);
  const { resolved, retry } = mockSaveReviewState.mock.calls[0][0];
  return { resolved, retry };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteJudgeComment.mockResolvedValue(undefined);
});

describe('reviewEntries — owed reviews', () => {
  it('reviews an owed entry the sampling did not pick, then clears it', async () => {
    tick({ pendingReview: { '7': 0 }, pending: [entry(7)] });
    mockGenerateReview.mockResolvedValue(review);

    await reviewEntries();

    expect(mockWriteJudgeComment).toHaveBeenCalledWith(expect.objectContaining({ imageId: 7 }));
    expect(metadataWrite()).toEqual({ resolved: ['7'], retry: {} });
  });

  it('reviews an entry that is both sampled and owed once', async () => {
    tick({ pendingReview: { '7': 0 }, sampled: [entry(7)], pending: [entry(7)] });
    mockGenerateReview.mockResolvedValue(review);

    await reviewEntries();

    expect(mockGenerateReview).toHaveBeenCalledTimes(1);
    expect(metadataWrite()).toEqual({ resolved: ['7'], retry: {} });
  });

  it('draws a bounded number of owed entries per tick and keeps the rest owed', async () => {
    const owed = Array.from({ length: MAX_OWED_REVIEWS_PER_TICK + 2 }, (_, i) => entry(i + 1));
    tick({
      pendingReview: Object.fromEntries(owed.map((e) => [e.imageId, 1])),
      pending: owed,
    });
    mockGenerateReview.mockResolvedValue(review);

    await reviewEntries();

    expect(mockGenerateReview).toHaveBeenCalledTimes(MAX_OWED_REVIEWS_PER_TICK);
    const { resolved, retry } = metadataWrite();
    expect(resolved).toHaveLength(MAX_OWED_REVIEWS_PER_TICK);
    expect(Object.values(retry)).toEqual([1, 1]);
  });

  it('clears an owed entry that is no longer eligible, without reviewing it', async () => {
    tick({ pendingReview: { '7': 1 }, pending: [] });

    await reviewEntries();

    expect(mockGenerateReview).not.toHaveBeenCalled();
    expect(metadataWrite()).toEqual({ resolved: ['7'], retry: {} });
  });

  it('owes a review to a sampled entry whose review failed', async () => {
    tick({ sampled: [entry(1), entry(2)] });
    mockGenerateReview.mockImplementation(async ({ creator }: { creator: string }) => {
      if (creator === 'user2') throw new Error('bad image');
      return review;
    });

    await reviewEntries();

    expect(metadataWrite()).toEqual({ resolved: [], retry: { '2': 1 } });
  });

  it('does not use up attempts while every review fails', async () => {
    tick({ pendingReview: { '1': 2 }, sampled: [entry(2)], pending: [entry(1)] });
    mockGenerateReview.mockRejectedValue(new Error('provider down'));

    await reviewEntries();

    expect(metadataWrite()).toEqual({ resolved: [], retry: { '1': 2, '2': 0 } });
  });
});

describe('settlePendingReview', () => {
  it(`drops an entry on its ${MAX_PENDING_REVIEW_ATTEMPTS}th counted failure`, () => {
    const settled = settlePendingReview({
      pending: { '1': MAX_PENDING_REVIEW_ATTEMPTS - 1, '2': 0 },
      failed: new Set([1, 2]),
      deferred: new Set(),
      succeeded: 1,
    });

    expect(settled).toEqual({ retry: { '2': 1 }, resolved: ['1'], dropped: [1] });
  });
});

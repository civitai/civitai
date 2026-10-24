import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChallengeJudgeService from '~/server/services/challenge-judge.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// The judge row is the ONLY source of the engine here: the real
// `challengeJudgingEngineForCreate` runs against this mocked read, so a create path that stopped
// consulting the judge fails these tests rather than quietly writing a hardcoded value.
const { mockTx, JUDGE_USER_ID, CREATOR_USER_ID } = vi.hoisted(() => {
  const JUDGE_USER_ID = 8_675_309;
  const CREATOR_USER_ID = 42;
  const tx = {
    challenge: { create: vi.fn().mockResolvedValue({ id: 2, collectionId: 10 }) },
    challengeEngagement: { create: vi.fn().mockResolvedValue({}) },
    collection: { create: vi.fn().mockResolvedValue({ id: 10 }) },
  };
  return {
    JUDGE_USER_ID,
    CREATOR_USER_ID,
    mockTx: tx,
  };
});

const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
// Not canonical defaults, so they have to be said explicitly: the cover-image lookup returns a
// row, and the transaction runs its callback against this file's own `tx`.
mockDbRead.image.findFirst.mockResolvedValue({ id: 1 });
mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  isFlipt: vi.fn().mockResolvedValue(false),
}));

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
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateThemeElements: vi.fn().mockResolvedValue([]),
  generateWinners: vi.fn(),
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({ getJudgedEntries: vi.fn() }));
vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
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

vi.mock('~/server/services/challenge-eligibility.service', () => ({
  assertCanCreateUserChallenge: vi.fn(),
  assertUserInGoodStanding: vi.fn(),
  assertUserAccountInGoodStanding: vi.fn(),
}));

vi.mock('~/server/services/challenge-judge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeJudgeService>()),
  getUserSelectableJudges: vi.fn().mockResolvedValue([{ id: 3 }]),
}));

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));

const { upsertChallenge, upsertUserChallenge } = await import(
  '~/server/services/challenge.service'
);

const modInput = {
  title: 'Test challenge',
  description: 'A description',
  startsAt: new Date('2026-08-01T00:00:00Z'),
  endsAt: new Date('2026-08-05T00:00:00Z'),
  visibleAt: new Date('2026-07-29T00:00:00Z'),
  coverImage: { id: 1 },
  prizes: [],
  userId: CREATOR_USER_ID,
  judgeId: 3,
};

const userInput = {
  title: 'User challenge',
  description: 'A description',
  startsAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
  endsAt: new Date(Date.now() + 96 * 60 * 60 * 1000),
  coverImage: { id: 1 },
  maxEntriesPerUser: 5,
  entryFee: 0,
  initialPrizeBuzz: 0,
  judgeId: 3,
  userId: CREATOR_USER_ID,
  buzzType: 'yellow',
};

function judgeWith(judgingEngine: string) {
  mockDbRead.challengeJudge.findUnique.mockResolvedValue({
    userId: JUDGE_USER_ID,
    judgingEngine,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
});

describe.each([
  ['upsertChallenge (mod create)', () => upsertChallenge(modInput as never)],
  ['upsertUserChallenge (creator create)', () => upsertUserChallenge(userInput as never)],
])('%s — judging engine copied from the judge', (_name, create) => {
  it('writes the judge’s engine onto the new challenge', async () => {
    judgeWith('pairwise-ladder');

    await create();

    expect(mockTx.challenge.create).toHaveBeenCalledTimes(1);
    expect(mockTx.challenge.create.mock.calls[0][0].data.judgingEngine).toBe('pairwise-ladder');
  });

  it('omits the column entirely for a legacy judge', async () => {
    judgeWith('legacy-absolute');

    await create();

    expect(mockTx.challenge.create).toHaveBeenCalledTimes(1);
    expect(mockTx.challenge.create.mock.calls[0][0].data).not.toHaveProperty('judgingEngine');
  });

  it('omits the column for an engine the registry does not know', async () => {
    judgeWith('swiss-tournament');

    await create();

    expect(mockTx.challenge.create.mock.calls[0][0].data).not.toHaveProperty('judgingEngine');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as ChallengeHelpers from '~/server/games/daily-challenge/challenge-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;

// `checkImageEligibility` is what the challenge submit modal prechecks each library image against.
// Only an AUTO-DETECTED resource satisfies a challenge's model requirement: a `detected: false` row
// is asserted by the uploader (the post's model-version link, or `addResourceToPostImage`), so
// accepting one would let anyone claim the required model on any upload and enter.
//
// The two rejections are reported separately on purpose. "Wrong model" is the entrant's mistake;
// "Model not detected" means the image carries no generation metadata naming the model, which is a
// different thing to tell them and a different thing for them to do about it. Reporting the former
// for the latter is what sent a user to support insisting their image used the required model.

const { mockIsFlipt } = vi.hoisted(() => ({
  mockIsFlipt: vi.fn(),
}));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransaction: vi.fn(),
  createBuzzTransactionMany: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: vi.fn(),
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
  parseJudgeScore: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof ChallengeHelpers>();
  return { ...actual, getChallengeById: vi.fn(), resolveEventContext: vi.fn() };
});

vi.mock('~/server/games/daily-challenge/generative-content', () => ({ generateWinners: vi.fn() }));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({ getJudgedEntries: vi.fn() }));

vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  enqueueImageIngestion: vi.fn(),
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

vi.mock('~/server/services/text-moderation.service', () => ({ submitTextModeration: vi.fn() }));

vi.mock('~/utils/errorHandling', () => ({ withRetries: vi.fn((fn: () => unknown) => fn()) }));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

vi.mock('~/server/utils/errorHandling', () => ({
  throwNotFoundError: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

const { checkImageEligibility } = await import('~/server/services/challenge.service');

const CHALLENGE_ID = 511;
const IMAGE_ID = 139575771;
const REQUIRED_VERSION_ID = 3222543;

/** PG only, started an hour ago — so nothing but the model check can make an entry ineligible. */
function wireChallenge(modelVersionIds: number[] = [REQUIRED_VERSION_ID]) {
  mockDbRead.challenge.findUnique.mockResolvedValue({
    allowedNsfwLevel: 7,
    modelVersionIds,
    startsAt: new Date(Date.now() - 60 * 60 * 1000),
  });
}

function wireImage({ detected = [], manual = [] }: { detected?: number[]; manual?: number[] }) {
  mockDbRead.$queryRawUnsafe.mockResolvedValue([
    {
      id: IMAGE_ID,
      nsfwLevel: 1,
      createdAt: new Date(),
      modelVersionIds: detected.length ? detected : null,
      modelVersionIdsManual: manual.length ? manual : null,
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockResolvedValue(false);
});

describe('checkImageEligibility model requirement', () => {
  it('accepts an image whose required model was auto-detected', async () => {
    wireChallenge();
    wireImage({ detected: [REQUIRED_VERSION_ID, 3147780] });

    const [result] = await checkImageEligibility(CHALLENGE_ID, [IMAGE_ID]);

    expect(result).toEqual({ imageId: IMAGE_ID, eligible: true, reasons: [] });
  });

  it('reports "Model not detected" when the required model is only a manual resource', async () => {
    wireChallenge();
    wireImage({ detected: [], manual: [REQUIRED_VERSION_ID, 3147780] });

    const [result] = await checkImageEligibility(CHALLENGE_ID, [IMAGE_ID]);

    expect(result.eligible).toBe(false);
    // Telling this entrant they used the wrong model is false — they used it, we could not read it.
    expect(result.reasons).toEqual(['Model not detected']);
  });

  it('reports "Wrong model" when the image does not carry the required model at all', async () => {
    wireChallenge();
    wireImage({ detected: [999], manual: [888] });

    const [result] = await checkImageEligibility(CHALLENGE_ID, [IMAGE_ID]);

    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(['Wrong model']);
  });

  it('splits detected from manual resources in the query itself', async () => {
    wireChallenge();
    wireImage({ detected: [REQUIRED_VERSION_ID] });

    await checkImageEligibility(CHALLENGE_ID, [IMAGE_ID]);

    // Reading both buckets out of one aggregate is what lets the reason be specific; a query that
    // aggregates every resource into one array can only ever say "Wrong model".
    const [sql] = mockDbRead.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('ir.detected IS TRUE');
    expect(sql).toContain('ir.detected IS NOT TRUE');
  });

  it('skips the model check when the challenge requires no model', async () => {
    wireChallenge([]);
    wireImage({ manual: [REQUIRED_VERSION_ID] });

    const [result] = await checkImageEligibility(CHALLENGE_ID, [IMAGE_ID]);

    expect(result.eligible).toBe(true);
  });
});

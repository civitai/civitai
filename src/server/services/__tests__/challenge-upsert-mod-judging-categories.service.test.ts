import { Prisma } from '@prisma/client';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task 5: the moderator upsert path (`upsertChallenge`) persists `judgingCategories` the same
// way `upsertUserChallenge` does (cast straight through to Prisma.InputJsonValue), and — unlike
// the user path — does NOT null out `judgingPrompt`: mods can compose a free-form AI persona
// prompt with category-based scoring dimensions.
//
// Unlike the user path, `judgingCategories` is optional/nullable here, so undefined/null must be
// converted to `Prisma.JsonNull` (mirroring the `entryPrize`/`prizeDistribution` fields in this
// same function) — a bare `null` cast to `Prisma.InputJsonValue` throws a
// PrismaClientValidationError at runtime for a Json? column.

const { mockDbRead, mockDbWrite, mockTx, mockCreateImage, mockGetChallengeConfig } = vi.hoisted(
  () => {
    const tx = {
      challenge: {
        update: vi.fn().mockResolvedValue({ id: 1 }),
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
      mockDbRead: { challenge: { findUnique: vi.fn() } },
      mockDbWrite: { $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(tx)) },
      mockCreateImage: vi.fn(),
      mockGetChallengeConfig: vi.fn().mockResolvedValue({ defaultJudgeId: 1 }),
    };
  }
);

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));

vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: {},
  isFlipt: vi.fn().mockResolvedValue(false),
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(),
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
  getChallengeConfig: mockGetChallengeConfig,
  setChallengeConfig: vi.fn(),
  deriveChallengeNsfwLevel: vi.fn(() => 1),
  getJudgingConfig: vi.fn(),
  refreshDefaultJudgeCache: vi.fn(),
  parseJudgeScore: vi.fn(),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateArticle: vi.fn(),
  generateReview: vi.fn(),
  generateThemeElements: vi.fn().mockResolvedValue([]),
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

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));

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

vi.mock('~/server/integrations/moderation', () => ({
  extModeration: {},
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

const { upsertChallenge } = await import('~/server/services/challenge.service');
const { ChallengeStatus } = await import('~/shared/utils/prisma/enums');

const { CHALLENGE_PRESET_CATEGORIES } = await import('~/shared/constants/challenge.constants');

// Client-submitted rows: key + weight only (label/criteria are derived server-side).
const VALID_CATEGORIES = [
  { key: 'theme', weight: 60 },
  { key: 'aesthetic', weight: 40 },
];
// What resolveJudgingCategories derives from the category library (preset fallback in tests —
// the mocked db client has no challengeCategory model).
const RESOLVED_CATEGORIES = [
  {
    key: 'theme',
    weight: 60,
    label: CHALLENGE_PRESET_CATEGORIES.theme.label,
    criteria: CHALLENGE_PRESET_CATEGORIES.theme.criteria,
  },
  {
    key: 'aesthetic',
    weight: 40,
    label: CHALLENGE_PRESET_CATEGORIES.aesthetic.label,
    criteria: CHALLENGE_PRESET_CATEGORIES.aesthetic.criteria,
  },
];

// Minimal moderator upsert payload. Cast at the call site (mirrors `as never` used elsewhere in
// this test suite) rather than fill out every defaulted field's exact optional/required shape.
const baseInput = {
  userId: 999,
  title: 'A test challenge',
  theme: 'Neon',
  coverImage: { id: 555, url: 'unused' },
  themeElements: ['already', 'provided'], // skip auto-generation
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  modelVersionIds: [],
  judgeId: 1,
  judgingPrompt: 'Custom AI persona prompt',
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
  startsAt: new Date(Date.now() + 86400000),
  endsAt: new Date(Date.now() + 2 * 86400000),
  visibleAt: new Date(),
  status: ChallengeStatus.Scheduled,
  source: 'Mod',
};

describe('upsertChallenge (moderator path) — judgingCategories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx.challenge.update.mockResolvedValue({ id: 1 });
    mockTx.challenge.create.mockResolvedValue({ id: 2 });
    mockTx.collection.create.mockResolvedValue({ id: 10 });
    mockDbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(mockTx));
  });

  it('create: persists judgingCategories and preserves judgingPrompt (both, composed)', async () => {
    await upsertChallenge({ ...baseInput, judgingCategories: VALID_CATEGORIES } as never);

    expect(mockTx.challenge.create).toHaveBeenCalledTimes(1);
    const callArg = mockTx.challenge.create.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toEqual(RESOLVED_CATEGORIES);
    expect(callArg.data.judgingPrompt).toBe('Custom AI persona prompt');
  });

  it('create: omitting judgingCategories writes Prisma.JsonNull (reads back as null)', async () => {
    await upsertChallenge({ ...baseInput, judgingCategories: undefined } as never);

    const callArg = mockTx.challenge.create.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toBe(Prisma.JsonNull);
  });

  // Regression guard: a bare `null` cast to `Prisma.InputJsonValue` (skipping the ternary) throws
  // PrismaClientValidationError for a Json? column at runtime — TS doesn't catch this because
  // `as unknown as X` bypasses the check that would otherwise flag `null` as non-assignable.
  it('create: explicit null judgingCategories writes Prisma.JsonNull, not a bare null', async () => {
    await upsertChallenge({ ...baseInput, judgingCategories: null } as never);

    const callArg = mockTx.challenge.create.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toBe(Prisma.JsonNull);
    expect(callArg.data.judgingCategories).not.toBeNull();
  });

  it('update: persists judgingCategories and preserves judgingPrompt (both, composed)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: null,
      metadata: null,
      status: ChallengeStatus.Scheduled,
      startsAt: baseInput.startsAt,
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
    });

    await upsertChallenge({
      ...baseInput,
      id: 1,
      judgingCategories: VALID_CATEGORIES,
    } as never);

    expect(mockTx.challenge.update).toHaveBeenCalledTimes(1);
    const callArg = mockTx.challenge.update.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toEqual(RESOLVED_CATEGORIES);
    expect(callArg.data.judgingPrompt).toBe('Custom AI persona prompt');
  });

  it('update: explicit null judgingCategories writes Prisma.JsonNull (no crash)', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: null,
      metadata: null,
      status: ChallengeStatus.Scheduled,
      startsAt: baseInput.startsAt,
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
    });

    await upsertChallenge({ ...baseInput, id: 1, judgingCategories: null } as never);

    const callArg = mockTx.challenge.update.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toBe(Prisma.JsonNull);
  });

  // Categories lock once a challenge starts: entries are already judged against them, so an
  // Active-challenge save must keep the stored value regardless of what the client submits.
  it('update (Active): keeps stored judgingCategories, ignoring submitted changes', async () => {
    const stored = [{ key: 'theme', weight: 100, label: 'Theme', criteria: 'stored' }];
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: null,
      metadata: null,
      status: ChallengeStatus.Active,
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
      judgingCategories: stored,
    });

    await upsertChallenge({
      ...baseInput,
      id: 1,
      status: ChallengeStatus.Active,
      judgingCategories: VALID_CATEGORIES,
    } as never);

    const callArg = mockTx.challenge.update.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toEqual(stored);
  });

  it('update (Active): a null-category challenge stays null even if categories are submitted', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      collectionId: null,
      metadata: null,
      status: ChallengeStatus.Active,
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

    await upsertChallenge({
      ...baseInput,
      id: 1,
      status: ChallengeStatus.Active,
      judgingCategories: VALID_CATEGORIES,
    } as never);

    const callArg = mockTx.challenge.update.mock.calls[0][0];
    expect(callArg.data.judgingCategories).toBe(Prisma.JsonNull);
  });
});

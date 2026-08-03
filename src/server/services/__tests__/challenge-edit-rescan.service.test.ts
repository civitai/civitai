import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression coverage for the edit→scan dedup deadlock: an edit that leaves the moderated text
// (title/theme/description/invitation) unchanged must NOT reset ingestion to Pending. The re-scan
// submit dedups on contentHash against the already-Succeeded EntityModeration row, so no webhook
// ever fires to flip ingestion back to Scanned — the challenge would sit hidden until the
// activation job voids it.
const { mockDbRead, mockDbWrite, mockTx, mockSubmitTextModeration } = vi.hoisted(() => {
  const mockTx = {
    challenge: {
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    collection: { findUnique: vi.fn(), update: vi.fn() },
  };
  return {
    mockTx,
    mockDbRead: {
      $queryRaw: vi.fn(),
      challenge: { findUnique: vi.fn() },
      collectionItem: { count: vi.fn() },
      image: { findUnique: vi.fn(), findFirst: vi.fn() },
    },
    mockDbWrite: {
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    },
    mockSubmitTextModeration: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
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

// Keep the real challenge-helpers (buildChallengeModerationText drives the behavior under test);
// its DB/logging imports are already mocked above.
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('~/server/games/daily-challenge/challenge-helpers')
  >();
  return { ...actual, getChallengeById: vi.fn() };
});

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateWinners: vi.fn(),
}));

vi.mock('~/server/jobs/daily-challenge-processing', () => ({
  getJudgedEntries: vi.fn(),
}));

vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: vi.fn() },
}));

vi.mock('~/server/services/image.service', () => ({
  createImage: vi.fn(),
  imagesForModelVersionsCache: { bust: vi.fn(), fetch: vi.fn(() => ({})) },
}));

vi.mock('~/server/services/user.service', () => ({
  getCosmeticsForUsers: vi.fn(() => ({})),
  getProfilePicturesForUsers: vi.fn(() => ({})),
}));

vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(),
}));

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

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn(),
}));

vi.mock('~/utils/errorHandling', () => ({
  withRetries: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('~/utils/logging', () => ({
  createLogger: vi.fn(() => vi.fn()),
}));

vi.mock('~/server/utils/errorHandling', () => ({
  throwNotFoundError: vi.fn((msg: string) => {
    throw new Error(msg);
  }),
}));

const { upsertUserChallenge } = await import('~/server/services/challenge.service');

const startsAt = new Date('2030-01-10T18:00:00Z');

const existingChallenge = {
  createdById: 111,
  source: 'User' as const,
  status: 'Scheduled' as const,
  collectionId: null,
  basePrizePool: 0,
  metadata: null,
  buzzType: 'yellow',
  startsAt,
  title: 'Cute Cats with Silly Hats',
  description: '<p>Show us your best cat.</p>',
  theme: 'Cats',
  invitation: null,
};

const baseEditInput = {
  id: 42,
  userId: 111,
  buzzType: 'yellow' as const,
  title: existingChallenge.title,
  description: existingChallenge.description,
  theme: existingChallenge.theme,
  invitation: null,
  coverImage: { id: 555, url: 'unused' },
  allowedNsfwLevel: 1,
  modelVersionIds: [],
  judgeId: null,
  judgingCategories: [],
  entryFee: 50,
  initialPrizeBuzz: 0,
  prizeDistribution: [],
  maxEntriesPerUser: 5,
  startsAt,
  endsAt: new Date('2030-01-12T18:00:00Z'),
};

describe('upsertUserChallenge (edit branch) — ingestion reset scoped to moderated-text changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    // First findUnique: the edit branch's `existing` load. scanUserChallenge (text-changed case)
    // re-reads the same row; a superset satisfies both selects.
    mockDbRead.challenge.findUnique.mockResolvedValue(existingChallenge);
    mockTx.challenge.updateMany.mockResolvedValue({ count: 1 });
    mockTx.challenge.findUniqueOrThrow.mockResolvedValue({ id: 42 });
  });

  it('keeps the scan verdict and skips re-scan when moderated text is unchanged', async () => {
    await upsertUserChallenge({
      ...baseEditInput,
      // Non-text edit: only the end date moves.
      endsAt: new Date('2030-01-13T18:00:00Z'),
    } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    const { data } = mockTx.challenge.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('ingestion');
    expect(data).not.toHaveProperty('scannedAt');
    expect(mockSubmitTextModeration).not.toHaveBeenCalled();
  });

  it('resets ingestion and re-scans when moderated text changed', async () => {
    await upsertUserChallenge({
      ...baseEditInput,
      title: 'Grumpy Dogs with Serious Hats',
    } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    const { data } = mockTx.challenge.updateMany.mock.calls[0][0];
    expect(data.ingestion).toBe('Pending');
    expect(data.scannedAt).toBeNull();
    expect(mockSubmitTextModeration).toHaveBeenCalledTimes(1);
  });

  it('keeps themeElements out of the challenge row write (metadata-only, no such column)', async () => {
    await upsertUserChallenge({
      ...baseEditInput,
      themeElements: ['cute cat', 'silly hat'],
    } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    const { data } = mockTx.challenge.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('themeElements');
    expect(data.metadata).toEqual({ themeElements: ['cute cat', 'silly hat'] });
    // Adding theme elements changes the moderated text, so the scan verdict must reset.
    expect(data.ingestion).toBe('Pending');
    expect(mockSubmitTextModeration).toHaveBeenCalledTimes(1);
  });

  it('persists clearing themeElements so the rescan content actually changes', async () => {
    // If the clear were dropped (old `...(themeEls && ...)` guard), the reset scan would submit
    // byte-identical text, hit the contentHash dedup, and the challenge would sit Pending until
    // voided — the exact deadlock this file's header describes.
    mockDbRead.challenge.findUnique.mockResolvedValue({
      ...existingChallenge,
      metadata: { themeElements: ['cute cat', 'silly hat'] },
    });

    await upsertUserChallenge({
      ...baseEditInput,
      themeElements: undefined,
    } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    const { data } = mockTx.challenge.updateMany.mock.calls[0][0];
    expect(data.metadata).not.toHaveProperty('themeElements');
    expect(data.ingestion).toBe('Pending');
    expect(mockSubmitTextModeration).toHaveBeenCalledTimes(1);
  });

  it('does not reset the scan when stored themeElements are resubmitted unchanged', async () => {
    mockDbRead.challenge.findUnique.mockResolvedValue({
      ...existingChallenge,
      metadata: { themeElements: ['cute cat', 'silly hat'] },
    });

    await upsertUserChallenge({
      ...baseEditInput,
      themeElements: ['cute cat', 'silly hat'],
    } as never);

    const { data } = mockTx.challenge.updateMany.mock.calls[0][0];
    expect(data).not.toHaveProperty('ingestion');
    expect(mockSubmitTextModeration).not.toHaveBeenCalled();
  });
});

describe('upsertUserChallenge (edit branch) — moderator edit access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbRead.image.findFirst.mockResolvedValue({ id: 555 });
    mockDbRead.challenge.findUnique.mockResolvedValue(existingChallenge);
    mockTx.challenge.updateMany.mockResolvedValue({ count: 1 });
    mockTx.challenge.findUniqueOrThrow.mockResolvedValue({ id: 42 });
  });

  it('rejects a non-owner without moderator status', async () => {
    await expect(
      upsertUserChallenge({ ...baseEditInput, userId: 222 } as never)
    ).rejects.toThrow('You can only edit your own challenges.');
    expect(mockTx.challenge.updateMany).not.toHaveBeenCalled();
  });

  it('lets a moderator edit another user challenge', async () => {
    await upsertUserChallenge({ ...baseEditInput, userId: 222, isModerator: true } as never);

    expect(mockTx.challenge.updateMany).toHaveBeenCalledTimes(1);
    // Cover reuse must not require the moderator to own the creator's image.
    expect(mockDbRead.image.findFirst).toHaveBeenCalledWith({
      where: { id: 555 },
      select: { id: true },
    });
  });

  it('still requires image ownership for a non-moderator owner', async () => {
    await upsertUserChallenge(baseEditInput as never);

    expect(mockDbRead.image.findFirst).toHaveBeenCalledWith({
      where: { id: 555, userId: 111 },
      select: { id: true },
    });
  });
});

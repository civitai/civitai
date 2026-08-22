import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * User-created challenges are still behind the `userChallenges` flag, but entries are written
 * through the generic collection mutations (`bulkSaveItems`, `addSimpleImagePost`), which are not
 * challenge-specific and carry no flag guard. Anyone with a direct link could therefore submit to
 * a user challenge while it is under test.
 *
 * The gate lives in `validateContestCollectionEntry` — the one choke point every entry path shares
 * — and must fire only for collections belonging to a User-source challenge, so ordinary contest
 * collections and System/Mod (daily) challenges are unaffected.
 *
 * Module-load scaffold mirrors contest-entry-resource-gate.test.ts.
 */

const COLLECTION_ID = 100;
const USER_ID = 5;
const IMAGE_ID = 9001;

const { mockChargeEntryFees } = vi.hoisted(() => ({ mockChargeEntryFees: vi.fn() }));

// `validateContestCollectionEntry` reads only — every Prisma call it makes is on dbRead
// (collection.service.ts). The mock this replaces bound dbWrite to `{}`, i.e. any write would have
// thrown; the canonical dbWrite answers instead, so a stray write would no longer be loud. Nothing
// on this path writes, and the entry-fee charge (the one side effect) is stubbed below.
const mockDbRead = dbMock.dbRead;
const mockChallengeFindFirst = mockDbRead.challenge.findFirst;

// `~/server/redis/client` is covered by the canonical mock registered in src/__tests__/setup.ts,
// which also supplies the REAL REDIS_*_KEYS tables in place of the placeholder proxy that used to
// answer every key lookup here. Nothing in this file asserts a key.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({ createLagTracker: vi.fn(() => ({})), loadDbEnv: vi.fn(() => ({})) }));
vi.mock('~/server/db/pgDb', () => ({ pgDbReadLong: {},  pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => ({ tagIdsForImagesCache: {}, userCollectionCountCache: {} }));
vi.mock('~/server/services/article.service', () => ({ getArticles: vi.fn() }));
vi.mock('~/server/services/home-block-cache.service', () => ({ homeBlockCacheBust: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  getAllImages: vi.fn(),
  enqueueImageIngestion: vi.fn(),
}));
vi.mock('~/server/services/model.service', () => ({
  getModelsWithVersions: vi.fn(),
  bustFeaturedModelsCache: vi.fn(),
  getModelsWithImagesAndModelVersions: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ getPostsInfinite: vi.fn() }));
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeEntryFees: mockChargeEntryFees,
}));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));

const { validateContestCollectionEntry } = await import('~/server/services/collection.service');

// The function makes several distinct `challenge.findFirst` lookups. The flag gate is the one
// that filters on source alone (no entryFee/status/createdById), so dispatch on that shape.
function wireChallengeFindFirst({ userChallengeCollection }: { userChallengeCollection: boolean }) {
  mockChallengeFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const isFlagGateLookup =
      where.source === 'User' && !('entryFee' in where) && !('createdById' in where);
    // status: 'Active' satisfies the assertUserChallengeAcceptingEntries timing gate (which shares
    // this source-only lookup shape) so the flag-gate behavior under test is what actually decides.
    if (isFlagGateLookup) return userChallengeCollection ? { id: 1, status: 'Active' } : null;
    return null; // every other challenge lookup: nothing configured
  });
}

const entry = (overrides: Record<string, unknown> = {}) =>
  validateContestCollectionEntry({
    collectionId: COLLECTION_ID,
    userId: USER_ID,
    imageIds: [IMAGE_ID],
    metadata: {},
    ...overrides,
  } as Parameters<typeof validateContestCollectionEntry>[0]);

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.user.findUnique.mockResolvedValue({ id: USER_ID, meta: {} });
  mockDbRead.$queryRaw.mockResolvedValue([]);
  mockDbRead.collection.findMany.mockResolvedValue([]);
  mockChargeEntryFees.mockResolvedValue({ paidImageIds: [IMAGE_ID], unpaidImageIds: [] });
});

describe('user-challenge entry flag gate', () => {
  it('rejects an entry into a user challenge when the submitter lacks the flag', async () => {
    wireChallengeFindFirst({ userChallengeCollection: true });

    await expect(entry({ canAccessUserChallenges: false })).rejects.toThrow(
      /not available|not currently available/i
    );
  });

  it('fails closed when the caller does not pass the flag at all', async () => {
    wireChallengeFindFirst({ userChallengeCollection: true });

    await expect(entry()).rejects.toThrow(/not available|not currently available/i);
  });

  it('rejects before any entry fee is charged', async () => {
    wireChallengeFindFirst({ userChallengeCollection: true });

    await expect(entry({ canAccessUserChallenges: false })).rejects.toThrow();
    expect(mockChargeEntryFees).not.toHaveBeenCalled();
  });

  it('allows the entry when the submitter has the flag', async () => {
    wireChallengeFindFirst({ userChallengeCollection: true });

    await expect(entry({ canAccessUserChallenges: true })).resolves.toBeUndefined();
  });

  it('leaves ordinary contest collections alone', async () => {
    // No challenge linked to this collection at all.
    wireChallengeFindFirst({ userChallengeCollection: false });

    await expect(entry({ canAccessUserChallenges: false })).resolves.toBeUndefined();
  });

  it('leaves System/Mod (daily) challenges alone', async () => {
    // The gate's lookup filters on source=User, so a daily challenge's collection returns null.
    wireChallengeFindFirst({ userChallengeCollection: false });

    await expect(entry({ canAccessUserChallenges: false })).resolves.toBeUndefined();
    expect(mockChallengeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ source: 'User' }) })
    );
  });
});

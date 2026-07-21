import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { mockChargeEntryFees, mockChallengeFindFirst, mockDbRead } = vi.hoisted(() => {
  const mockChargeEntryFees = vi.fn();
  const mockChallengeFindFirst = vi.fn();
  const mockDbRead = {
    user: { findUnique: vi.fn() },
    challenge: { findFirst: mockChallengeFindFirst },
    collectionItem: { count: vi.fn(), findFirst: vi.fn() },
    collection: { findMany: vi.fn() },
    image: { findMany: vi.fn() },
    article: { findMany: vi.fn() },
    model: { findMany: vi.fn() },
    post: { findMany: vi.fn() },
    imageResourceNew: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
  return { mockChargeEntryFees, mockChallengeFindFirst, mockDbRead };
});

vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: { get: vi.fn(), set: vi.fn(), packed: { get: vi.fn(), set: vi.fn() } },
    sysRedis: { get: vi.fn(), set: vi.fn() },
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
    REDIS_SUB_KEYS: keyProxy,
    withSysReadDeadline: vi.fn((p) => p),
  };
});
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('@civitai/db', () => ({ createLagTracker: vi.fn(() => ({})), loadDbEnv: vi.fn(() => ({})) }));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
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

const { validateContestCollectionEntry } = await import('~/server/services/collection.service');

// The function makes several distinct `challenge.findFirst` lookups. The flag gate is the one
// that filters on source alone (no entryFee/status/createdById), so dispatch on that shape.
function wireChallengeFindFirst({ userChallengeCollection }: { userChallengeCollection: boolean }) {
  mockChallengeFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const isFlagGateLookup =
      where.source === 'User' && !('entryFee' in where) && !('createdById' in where);
    if (isFlagGateLookup) return userChallengeCollection ? { id: 1 } : null;
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

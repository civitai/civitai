import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 11: validate the required-resource rule (Challenge.modelVersionIds) BEFORE the
 * entry-fee charge in validateContestCollectionEntry, not just at promotion (which runs
 * AFTER the fee already ran — see challenge-rewards.ts:promoteChallengeEntries). Entry fees
 * are never refunded (challenge-funding.ts), so an off-resource image used to be charged
 * then auto-rejected with no refund. These tests assert the gate throws before any charge
 * is attempted, and that a valid image still reaches the charge step.
 *
 * The module-load scaffold below (redis/db/search-index/sibling-service mocks) mirrors
 * collection.service.sysredis-soft.test.ts, which already proved this is the minimal set
 * needed to import collection.service.ts without pulling in kysely/@civitai/db.
 */

const REQUIRED_VERSION_ID = 111;
const COLLECTION_ID = 100;
const USER_ID = 5;
const IMAGE_ID = 9001;

const { mockChargeEntryFees, mockChallengeFindFirst, mockImageResourceNewFindMany, mockDbRead } =
  vi.hoisted(() => {
    const mockChargeEntryFees = vi.fn();
    const mockChallengeFindFirst = vi.fn();
    const mockImageResourceNewFindMany = vi.fn();
    const mockDbRead = {
      user: { findUnique: vi.fn() },
      challenge: { findFirst: mockChallengeFindFirst },
      collectionItem: { count: vi.fn(), findFirst: vi.fn() },
      collection: { findMany: vi.fn() },
      image: { findMany: vi.fn() },
      article: { findMany: vi.fn() },
      model: { findMany: vi.fn() },
      post: { findMany: vi.fn() },
      imageResourceNew: { findMany: mockImageResourceNewFindMany },
      $queryRaw: vi.fn(),
    };
    return { mockChargeEntryFees, mockChallengeFindFirst, mockImageResourceNewFindMany, mockDbRead };
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

// @civitai/db's index re-exports ./kysely, whose top-level `import 'kysely'` is not
// installed in this worktree. Replacing the whole package short-circuits that eval.
vi.mock('@civitai/db', () => ({
  createLagTracker: vi.fn(() => ({})),
  loadDbEnv: vi.fn(() => ({})),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  preventReplicationLag: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: {},
  userCollectionCountCache: {},
}));
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

// chargeContestEntryFeesForCollection dynamically imports this module at runtime — mock it
// so we can assert the fee charge is (or isn't) reached, without pulling in the buzz ledger.
vi.mock('~/server/games/daily-challenge/challenge-funding', () => ({
  chargeEntryFees: mockChargeEntryFees,
}));

const { validateContestCollectionEntry } = await import('~/server/services/collection.service');

// Dispatch dbRead.challenge.findFirst by the distinguishing field in its `where` clause —
// the function makes several distinct challenge lookups in sequence.
function wireChallengeFindFirst(opts: { hasResourceChallenge: boolean; hasFeeChallenge: boolean }) {
  mockChallengeFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    if ('createdById' in where) return null; // own-challenge self-entry check
    if ('modelVersionIds' in where) {
      return opts.hasResourceChallenge ? { modelVersionIds: [REQUIRED_VERSION_ID] } : null;
    }
    if ('maxParticipants' in where) return null; // no participant cap configured
    if (where.source === 'User') {
      return opts.hasFeeChallenge ? { id: 1, entryFee: 100, buzzType: 'yellow' } : null;
    }
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbRead.user.findUnique.mockResolvedValue({ id: USER_ID, meta: {} });
  mockDbRead.$queryRaw.mockResolvedValue([]); // alreadyJudged check: nothing already judged
  mockDbRead.collection.findMany.mockResolvedValue([]); // no featured collections
  mockChargeEntryFees.mockResolvedValue({ paidImageIds: [IMAGE_ID], unpaidImageIds: [] });
});

describe('contest entry resource gate (Task 11)', () => {
  it('rejects an image lacking any required modelVersionId before charging', async () => {
    wireChallengeFindFirst({ hasResourceChallenge: true, hasFeeChallenge: true });
    mockImageResourceNewFindMany.mockResolvedValue([]); // image has no matching resource

    await expect(
      validateContestCollectionEntry({
        collectionId: COLLECTION_ID,
        userId: USER_ID,
        // These cases enter a User-source challenge, which is behind the `userChallenges` flag.
        canAccessUserChallenges: true,
        imageIds: [IMAGE_ID],
        metadata: {},
      })
    ).rejects.toThrow('This image does not use a required model for this challenge.');

    expect(mockImageResourceNewFindMany).toHaveBeenCalledWith({
      where: { imageId: { in: [IMAGE_ID] }, modelVersionId: { in: [REQUIRED_VERSION_ID] } },
      select: { imageId: true },
      distinct: ['imageId'],
    });
    expect(mockChargeEntryFees).not.toHaveBeenCalled();
  });

  it('accepts an image that has one of the required versions and reaches the charge step', async () => {
    wireChallengeFindFirst({ hasResourceChallenge: true, hasFeeChallenge: true });
    mockImageResourceNewFindMany.mockResolvedValue([{ imageId: IMAGE_ID }]);

    await expect(
      validateContestCollectionEntry({
        collectionId: COLLECTION_ID,
        userId: USER_ID,
        // These cases enter a User-source challenge, which is behind the `userChallenges` flag.
        canAccessUserChallenges: true,
        imageIds: [IMAGE_ID],
        metadata: {},
      })
    ).resolves.toBeUndefined();

    expect(mockChargeEntryFees).toHaveBeenCalledTimes(1);
  });

  it('skips the gate entirely when the challenge has no modelVersionIds restriction', async () => {
    wireChallengeFindFirst({ hasResourceChallenge: false, hasFeeChallenge: true });

    await expect(
      validateContestCollectionEntry({
        collectionId: COLLECTION_ID,
        userId: USER_ID,
        // These cases enter a User-source challenge, which is behind the `userChallenges` flag.
        canAccessUserChallenges: true,
        imageIds: [IMAGE_ID],
        metadata: {},
      })
    ).resolves.toBeUndefined();

    expect(mockImageResourceNewFindMany).not.toHaveBeenCalled();
    expect(mockChargeEntryFees).toHaveBeenCalledTimes(1);
  });

  it('moderators bypass the resource gate', async () => {
    wireChallengeFindFirst({ hasResourceChallenge: true, hasFeeChallenge: true });
    mockImageResourceNewFindMany.mockResolvedValue([]); // would fail the gate if it ran

    await expect(
      validateContestCollectionEntry({
        collectionId: COLLECTION_ID,
        userId: USER_ID,
        // These cases enter a User-source challenge, which is behind the `userChallenges` flag.
        canAccessUserChallenges: true,
        isModerator: true,
        imageIds: [IMAGE_ID],
        metadata: {},
      })
    ).resolves.toBeUndefined();

    expect(mockImageResourceNewFindMany).not.toHaveBeenCalled();
    // Moderators are also exempt from the entry fee (chargeContestEntryFeesForCollection
    // no-ops for isModerator), so the fee charge is never invoked either.
    expect(mockChargeEntryFees).not.toHaveBeenCalled();
  });
});

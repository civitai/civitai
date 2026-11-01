import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as ReDerive from '~/server/services/blocks/app-listing-rating-rederive.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Avatars are gated in the browser on the profile picture's `nsfwLevel` and `ingestion`, and the hot
 * reads serve that picture from `profilePictureCache`. A moderator re-rating or blocking an image
 * that is someone's profile picture has to refresh that entry, or the old rating keeps passing the
 * gate until the cache TTL. The refresh runs after the moderation write commits, so its failure
 * must not fail the moderator's action.
 */

const refreshPicture = vi.fn(async (_ids: number | number[]) => undefined);

vi.mock('~/server/services/blocks/app-listing-rating-rederive.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReDerive>()),
  reDeriveListingRatingsForModeratedImage: vi.fn(async () => []),
}));

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
    profilePictureCache: {
      ...actual.profilePictureCache,
      refresh: (ids: number | number[]) => refreshPicture(ids),
    },
  };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => {
  const reset = { reset: vi.fn(() => Promise.resolve()) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const { updateImageNsfwLevel, handleBlockImages, updateNsfwLevel, resetBlockedNsfwLevel } =
  await import('../image.service');

const AVATAR = 7301;
const OTHER_IMAGE = 7302;
const AVATAR_OWNER = 4242;
const MOD = 9001;

/** The users whose profile picture is in the looked-up id set. */
function avatarsOf(owners: Record<number, number>) {
  dbMock.dbWrite.user.findMany.mockImplementation((async ({
    where,
  }: {
    where: { profilePictureId?: { in: number[] } };
  }) =>
    (where.profilePictureId?.in ?? [])
      .filter((id) => owners[id] !== undefined)
      .map((id) => ({ id: owners[id] }))) as never);
}

const pictureLookups = () =>
  dbMock.dbWrite.user.findMany.mock.calls
    .map(([args]) => (args as { where: { profilePictureId?: { in: number[] } } }).where)
    .filter((where) => where.profilePictureId)
    .map((where) => [...(where.profilePictureId?.in ?? [])].sort());

const reRate = (id: number) =>
  updateImageNsfwLevel({ id, nsfwLevel: NsfwLevel.X, userId: MOD, isModerator: true } as never);

beforeEach(() => {
  vi.clearAllMocks();
  refreshPicture.mockImplementation(async () => undefined);
  avatarsOf({ [AVATAR]: AVATAR_OWNER });
  dbMock.dbWrite.image.findUnique.mockResolvedValue({
    metadata: {},
    postId: null,
    nsfwLevel: NsfwLevel.PG,
  } as never);
  dbMock.dbWrite.image.update.mockResolvedValue({} as never);
});

describe('a moderator re-rate', () => {
  it('refreshes the cached profile picture of the user whose avatar it is', async () => {
    await reRate(AVATAR);

    expect(pictureLookups()).toEqual([[AVATAR]]);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    // After the write, or the refresh re-reads the old rating.
    expect(dbMock.dbWrite.image.update.mock.invocationCallOrder[0]).toBeLessThan(
      refreshPicture.mock.invocationCallOrder[0]
    );
  });

  it('refreshes nothing for an image that is nobody’s avatar', async () => {
    await reRate(OTHER_IMAGE);

    expect(pictureLookups()).toEqual([[OTHER_IMAGE]]);
    expect(refreshPicture).not.toHaveBeenCalled();
  });

  it('still succeeds when the refresh or the avatar lookup fails', async () => {
    refreshPicture.mockRejectedValue(new Error('cache down'));
    await expect(reRate(AVATAR)).resolves.toBe(NsfwLevel.X);

    dbMock.dbWrite.user.findMany.mockRejectedValue(new Error('db down'));
    await expect(reRate(AVATAR)).resolves.toBe(NsfwLevel.X);
  });
});

// The tag-derived recompute: unblocks, appeal approvals and account restores reach it through
// resetBlockedNsfwLevel, and its result can move an avatar across the safe-for-work gate either way.
describe('a recompute of the rating from tags', () => {
  it('refreshes the cached profile picture of the user whose avatar was recomputed, after it', async () => {
    await updateNsfwLevel([AVATAR, OTHER_IMAGE]);

    expect(pictureLookups()).toEqual([[AVATAR, OTHER_IMAGE]]);
    expect(refreshPicture).toHaveBeenCalledTimes(1);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    expect(dbMock.dbWrite.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(
      refreshPicture.mock.invocationCallOrder[0]
    );
  });

  it('refreshes it when an unblock resets and recomputes the rating', async () => {
    await resetBlockedNsfwLevel(AVATAR);

    expect(pictureLookups()).toEqual([[AVATAR]]);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
  });

  it('refreshes nothing for images that are nobody’s avatar', async () => {
    await updateNsfwLevel(OTHER_IMAGE);

    expect(pictureLookups()).toEqual([[OTHER_IMAGE]]);
    expect(refreshPicture).not.toHaveBeenCalled();
  });

  it('still completes when the refresh or the avatar lookup fails', async () => {
    refreshPicture.mockRejectedValue(new Error('cache down'));
    await expect(updateNsfwLevel(AVATAR)).resolves.toBeUndefined();

    dbMock.dbWrite.user.findMany.mockRejectedValue(new Error('db down'));
    await expect(updateNsfwLevel(AVATAR)).resolves.toBeUndefined();
  });
});

describe('a moderator block', () => {
  beforeEach(() => {
    // The block chains `.then` off this write; the shared db mock has no default for `updateMany`.
    dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 2 } as never);
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { id: AVATAR, userId: AVATAR_OWNER, postId: null, nsfwLevel: 1, blockedFor: null },
      { id: OTHER_IMAGE, userId: AVATAR_OWNER, postId: null, nsfwLevel: 1, blockedFor: null },
    ] as never);
  });

  it('refreshes the avatars among the blocked images, after the block', async () => {
    await handleBlockImages({ ids: [AVATAR, OTHER_IMAGE], moderatorId: MOD } as never);

    expect(pictureLookups()).toEqual([[AVATAR, OTHER_IMAGE]]);
    expect(refreshPicture).toHaveBeenCalledTimes(1);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    expect(dbMock.dbWrite.image.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      refreshPicture.mock.invocationCallOrder[0]
    );
  });

  it("refreshes the account's own avatar without listing every image when blocking a whole account", async () => {
    await handleBlockImages({ userId: AVATAR_OWNER, moderatorId: MOD } as never);

    expect(pictureLookups()).toEqual([]);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
  });

  it('still succeeds when the refresh fails', async () => {
    refreshPicture.mockRejectedValue(new Error('cache down'));

    await expect(
      handleBlockImages({ ids: [AVATAR, OTHER_IMAGE], moderatorId: MOD } as never)
    ).resolves.toBeDefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as ReDerive from '~/server/services/blocks/app-listing-rating-rederive.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { NsfwLevel } from '~/server/common/enums';
import { refreshSession } from '~/server/auth/session-invalidation';
import * as refreshAlert from '~/server/services/profile-picture-refresh-alert';

/**
 * Avatars are gated in the browser on the profile picture's `nsfwLevel` and `ingestion`, and the hot
 * reads serve that picture from `profilePictureCache`. A moderator re-rating or blocking an image
 * that is someone's profile picture has to refresh that entry, or the old rating keeps passing the
 * gate until the cache TTL. The refresh runs after the moderation write commits, so its failure
 * must not fail the moderator's action.
 */

const refreshPicture = vi.fn(async (_ids: number | number[]) => undefined);
const refreshBasic = vi.fn(async (_ids: number | number[]) => undefined);
const queueUserUpdate = vi.fn(async (_items: unknown[]) => undefined);
const clearImages = vi.fn(async (_db: unknown, _ids: number[]) => [] as number[]);
const pictureLookup = vi.fn();
const alertStep = vi
  .spyOn(refreshAlert, 'alertRefreshStepFailure')
  .mockImplementation(() => undefined);

vi.mock('~/server/services/held-image-keys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearHeldUserImages: (db: unknown, ids: number[]) => clearImages(db, ids),
  // The lookup's SQL runs against Postgres in held-avatar-clear.behavior.test.ts; here it answers
  // from the same user fake as the profile pictures.
  getPictureUserIds: async (db: typeof dbMock.dbWrite, ids: number[]) => {
    pictureLookup(db, ids);
    return (
      (await db.user.findMany({
        where: { profilePictureId: { in: ids } },
        select: { id: true },
      })) as { id: number }[]
    ).map((row) => row.id);
  },
}));

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
    userBasicCache: {
      ...actual.userBasicCache,
      refresh: (ids: number | number[]) => refreshBasic(ids),
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
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  usersSearchIndex: { queueUpdate: (items: unknown[]) => queueUserUpdate(items) },
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

const {
  updateImageNsfwLevel,
  handleBlockImages,
  handleUnblockImages,
  updateNsfwLevel,
  resetBlockedNsfwLevel,
  reportCsamImages,
} = await import('../image.service');

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

describe('an avatar change', () => {
  it("busts the event engine's copy of the user's picture too", async () => {
    const { deleteUserProfilePictureCache } = await import('../user.service');

    await deleteUserProfilePictureCache(AVATAR_OWNER);

    expect(refreshPicture).toHaveBeenCalledWith(AVATAR_OWNER);
    expect(redisMock.redis.hSet).toHaveBeenCalledWith(`user:profilePicture:v3:${AVATAR_OWNER}`, {
      debounce: '1',
      cachedAt: expect.any(String),
    });
  });
});

describe('a bulk picture refresh', () => {
  it("clears a User.image naming a held picture, then refreshes those users' basic-user cache and search documents", async () => {
    const { refreshProfilePicturesForUsers } = await import('../user.service');
    clearImages.mockRejectedValueOnce(new Error('clear failed'));
    await refreshProfilePicturesForUsers([3, 4, 3]);
    expect(clearImages).toHaveBeenLastCalledWith(expect.anything(), [3, 4]);
    expect(refreshPicture).toHaveBeenLastCalledWith([3, 4]);
    expect(refreshBasic).not.toHaveBeenCalled();

    clearImages.mockResolvedValueOnce([]);
    await refreshProfilePicturesForUsers([3, 4]);
    expect(refreshBasic).not.toHaveBeenCalled();
    expect(queueUserUpdate).not.toHaveBeenCalled();

    // The event engine's copy of each picture is busted whether or not it is held.
    expect(redisMock.redis.hSet).toHaveBeenCalledWith('user:profilePicture:v3:3', {
      debounce: '1',
      cachedAt: expect.any(String),
    });
    expect(redisMock.redis.expire).toHaveBeenCalledWith('user:profilePicture:v3:4', 10);

    clearImages.mockResolvedValueOnce([4]);
    await refreshProfilePicturesForUsers([3, 4]);
    expect(refreshBasic).toHaveBeenCalledWith([4]);
    expect(clearImages.mock.invocationCallOrder[2]).toBeLessThan(
      refreshBasic.mock.invocationCallOrder[0]
    );
    expect(queueUserUpdate).toHaveBeenCalledWith([{ id: 4, action: 'Update' }]);
  });

  it('refreshes the picture cache but not the basic-user entry of a user the clear did not touch', async () => {
    const { refreshProfilePicturesForUsers } = await import('../user.service');
    clearImages.mockResolvedValueOnce([]);

    await refreshProfilePicturesForUsers([9]);

    expect(refreshPicture).toHaveBeenCalledWith([9]);
    expect(refreshBasic).not.toHaveBeenCalled();
    expect(queueUserUpdate).not.toHaveBeenCalled();
  });

  it('🔴 alerts a failed step by name and still runs the steps after it', async () => {
    const { refreshProfilePicturesForUsers } = await import('../user.service');
    clearImages.mockResolvedValueOnce([9]);
    refreshPicture.mockRejectedValueOnce(new Error('redis down'));

    await expect(refreshProfilePicturesForUsers([9])).resolves.toBeUndefined();

    expect(alertStep).toHaveBeenCalledWith('picture-cache');
    expect(alertStep).toHaveBeenCalledTimes(1);
    expect(refreshBasic).toHaveBeenCalledWith([9]);
  });

  it('alerts nothing when every step succeeds (control)', async () => {
    const { refreshProfilePicturesForUsers } = await import('../user.service');
    clearImages.mockResolvedValueOnce([9]);
    await refreshProfilePicturesForUsers([9]);
    expect(alertStep).not.toHaveBeenCalled();
  });

  it('refreshes every session, never more than the cap at once', async () => {
    const { refreshProfilePicturesForUsers, PROFILE_PICTURE_SESSION_REFRESH_CONCURRENCY } =
      await import('../user.service');
    let inFlight = 0;
    let peak = 0;
    vi.mocked(refreshSession).mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return undefined as never;
    });
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);

    await refreshProfilePicturesForUsers(ids);

    expect(
      vi
        .mocked(refreshSession)
        .mock.calls.map(([id]) => id)
        .sort((a, b) => a - b)
    ).toEqual(ids);
    expect(peak).toBe(PROFILE_PICTURE_SESSION_REFRESH_CONCURRENCY);
  });
});

describe('a moderator re-rate', () => {
  it('refreshes the cached profile picture of the user whose avatar it is', async () => {
    await reRate(AVATAR);

    expect(pictureLookups()).toEqual([[AVATAR]]);
    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    // The session shape carries the picture's url too.
    expect(refreshSession).toHaveBeenCalledWith(
      AVATAR_OWNER,
      expect.objectContaining({ caller: 'profile' })
    );
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
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
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

describe('a moderator unblock', () => {
  beforeEach(() => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { id: AVATAR, userId: AVATAR_OWNER, postId: null, nsfwLevel: 1, blockedFor: null },
    ] as never);
  });

  it('refreshes the cached profile picture after the image is set back to Scanned', async () => {
    await handleUnblockImages({ ids: [AVATAR], moderatorId: MOD } as never);

    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    const unblock = dbMock.dbWrite.$queryRaw.mock.calls.findIndex(([strings]) =>
      (strings as TemplateStringsArray).join('?').includes(`"ingestion" = 'Scanned'`)
    );
    expect(unblock).toBeGreaterThanOrEqual(0);
    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[unblock]).toBeLessThan(
      refreshPicture.mock.invocationCallOrder[0]
    );
  });
});

describe('a moderator report flag', () => {
  it('refreshes the cached profile picture of the user whose avatar was flagged, after the flag', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { userId: AVATAR_OWNER, reports: [] },
    ] as never);

    await reportCsamImages({ imageIds: [AVATAR], user: { id: MOD, isModerator: true } } as never);

    expect(refreshPicture).toHaveBeenCalledWith([AVATAR_OWNER]);
    expect(dbMock.dbWrite.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      refreshPicture.mock.invocationCallOrder[0]
    );
  });
});

describe('the users an image change reaches', () => {
  it('come from the shared lookup, on the primary', async () => {
    await reRate(AVATAR);
    expect(pictureLookup).toHaveBeenCalledWith(dbMock.dbWrite, [AVATAR]);
  });
});

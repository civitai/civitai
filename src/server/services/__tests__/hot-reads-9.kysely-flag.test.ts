import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads9 from '@civitai/db-queries/hot-reads-9';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-9 statement stubbed: its row against Prisma's is compared in
// hot-reads-9.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-9', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads9>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
vi.mock('~/server/redis/caches', () => ({
  getUserContentOverview: vi.fn(async () => ({})),
  getUserContentOverviewPublic: vi.fn(async () => ({})),
  getUserContentOverviewSfw: vi.fn(async () => ({})),
}));
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));

import * as queries from '@civitai/db-queries/hot-reads-9';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { userWithProfileSelect } from '~/server/selectors/user.selector';

/**
 * `getUserWithProfile` behind `kysely-hot-reads-9`: the flag is evaluated by its key, with no
 * entity or context, once per call; OFF reads through Prisma on the primary only, exactly as
 * before; ON reads through the one Kysely statement on the PRIMARY client and returns a value that
 * can only have come from the Kysely row (the ON fixture differs from the OFF one). Row parity
 * against a real database is in hot-reads-9.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));
const FLAG = 'kysely-hot-reads-9';

// Pairwise distinct.
const USER = 9801;
const VIEWER = 9802;
const LINK = 9803;
const COSMETIC = 9804;

const load = async () =>
  (await import('~/server/services/user-profile.service')).getUserWithProfile;

/** The Prisma-shaped user, with a profile so the service does not upsert one. */
const prismaUser = (bio: string) => ({
  id: USER,
  username: 'someone',
  deletedAt: null,
  image: null,
  profilePicture: null,
  leaderboardShowcase: null,
  createdAt: new Date(0),
  muted: false,
  cosmetics: [],
  links: [{ id: LINK, url: 'https://x.example', type: 'Social' }],
  rank: null,
  profile: {
    bio,
    coverImageId: null,
    coverImage: null,
    message: null,
    messageAddedAt: null,
    sfwBio: null,
    sfwMessage: null,
    sfwMessageAddedAt: null,
    sfwCoverImageId: null,
    sfwCoverImage: null,
    profileSectionsSettings: [],
    privacySettings: {},
    showcaseItems: [],
    location: null,
    nsfw: false,
    userId: USER,
  },
  bannedAt: null,
  meta: {},
  publicSettings: {},
  settings: null,
});

/** The Kysely row the same user comes back as, with a bio and a cosmetic the OFF fixture lacks. */
const kyselyRow = {
  id: USER,
  username: 'someone',
  deletedAt: null,
  image: null,
  leaderboardShowcase: null,
  createdAt: new Date(0),
  muted: false,
  bannedAt: null,
  meta: {},
  publicSettings: {},
  settings: null,
  profilePictureId: null,
  rankUserId: null,
  profileUserId: USER,
  profileBio: 'from kysely',
  profileCoverImageId: null,
  profileMessage: null,
  profileMessageAddedAt: null,
  profileSfwBio: null,
  profileSfwMessage: null,
  profileSfwMessageAddedAt: null,
  profileSfwCoverImageId: null,
  profileSectionsSettings: [],
  profilePrivacySettings: {},
  profileShowcaseItems: [],
  profileLocation: null,
  profileNsfw: false,
  coverId: null,
  sfwCoverId: null,
  coverTags: [],
  sfwCoverTags: [],
  links: [{ id: LINK, url: 'https://x.example', type: 'Social' }],
  cosmetics: [
    {
      equippedAtMs: null,
      cosmeticId: COSMETIC,
      obtainedAtMs: 1_000,
      claimKey: 'claimed',
      data: null,
      cosmetic: {
        id: COSMETIC,
        data: {},
        type: 'Badge',
        source: 'Claim',
        name: 'from kysely',
        description: null,
        videoUrl: null,
      },
    },
  ],
};

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  dbMock.dbRead.userStat.findFirst.mockResolvedValue(null as never);
});

describe('control', () => {
  it('the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('getUserWithProfile', () => {
  it('OFF: the Prisma read on the primary, with the select it always had', async () => {
    dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue(prismaUser('from prisma') as never);
    const user = await (await load())({ username: 'someone', sessionUserId: VIEWER });
    expect(user.profile.bio).toBe('from prisma');
    expect(user.links).toEqual([{ id: LINK, url: 'https://x.example', type: 'Social' }]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbWrite.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.user.findUniqueOrThrow.mock.calls[0][0]).toEqual({
      where: { id: undefined, username: 'someone', deletedAt: null },
      select: {
        ...userWithProfileSelect,
        bannedAt: true,
        meta: true,
        publicSettings: true,
        settings: true,
      },
    });
    expectNoKyselyRead();
  });

  it('ON: the one Kysely statement on the primary, whose row is the result', async () => {
    flag.mockResolvedValue(true);
    q.getUserWithProfileRow.mockResolvedValue(kyselyRow as never);
    const user = await (await load())({ id: USER, sessionUserId: USER });
    expect(user.profile.bio).toBe('from kysely');
    expect(user.cosmetics).toEqual([
      {
        equippedAt: null,
        cosmeticId: COSMETIC,
        obtainedAt: new Date(1_000),
        claimKey: 'claimed',
        data: null,
        cosmetic: {
          id: COSMETIC,
          data: {},
          type: 'Badge',
          source: 'Claim',
          name: 'from kysely',
          description: null,
          videoUrl: null,
        },
      },
    ]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(q.getUserWithProfileRow.mock.calls).toEqual([
      [kyselyWrite, { id: USER, username: undefined }],
    ]);
    expect(q.getUserWithProfileRow.mock.calls[0][0]).toBe(kyselyWrite);
    expect(dbMock.dbWrite.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('ON, no such user: rejects with P2025 (NOT_FOUND), as Prisma', async () => {
    flag.mockResolvedValue(true);
    q.getUserWithProfileRow.mockResolvedValue(undefined as never);
    await expect((await load())({ username: 'nobody' })).rejects.toMatchObject({ code: 'P2025' });
  });

  it('ON, first visit: the profile is created, then the same Kysely read runs again', async () => {
    flag.mockResolvedValue(true);
    q.getUserWithProfileRow
      .mockResolvedValueOnce({ ...kyselyRow, profileUserId: null } as never)
      .mockResolvedValueOnce(kyselyRow as never);
    const user = await (await load())({ username: 'someone' });
    expect(user.profile.bio).toBe('from kysely');
    expect(dbMock.dbWrite.userProfile.upsert).toHaveBeenCalledTimes(1);
    expect(q.getUserWithProfileRow).toHaveBeenCalledTimes(2);
    // The flag is asked once per call, not once per read.
    expect(flag).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.user.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// A profile's cover and avatar reach a visitor only once the image is Scanned; the owner and
// moderators still get theirs.

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

import { getUserWithProfile } from '~/server/services/user-profile.service';

const OWNER = 77;
const VISITOR = 88;

const cover = (ingestion: string) => ({
  id: 1,
  url: `cover-${ingestion}`,
  name: null,
  type: 'image',
  needsReview: null,
  ingestion,
  meta: null,
  metadata: {},
  tags: [],
});
const picture = (ingestion: string) => ({
  id: 2,
  name: null,
  url: `avatar-${ingestion}`,
  nsfwLevel: 1,
  hash: null,
  userId: OWNER,
  ingestion,
  type: 'image',
  width: null,
  height: null,
  metadata: null,
});

function setUser(ingestion: string) {
  dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue({
    id: OWNER,
    username: 'creator',
    meta: {},
    settings: {},
    publicSettings: {},
    cosmetics: [],
    profilePicture: picture(ingestion),
    profile: {
      userId: OWNER,
      privacySettings: {},
      profileSectionsSettings: [],
      showcaseItems: [],
      coverImageId: 1,
      coverImage: cover(ingestion),
      sfwCoverImageId: null,
      sfwCoverImage: null,
    },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.userStat.findFirst.mockResolvedValue(null);
});

describe('getUserWithProfile — unscanned cover and avatar', () => {
  it.each(['Pending', 'Error'])('withholds a %s cover and avatar from a visitor', async (state) => {
    setUser(state);
    const signedIn = await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR });
    const signedOut = await getUserWithProfile({ id: OWNER });

    for (const user of [signedIn, signedOut]) {
      expect(user.profile.coverImage).toBeNull();
      expect(user.profilePicture).toBeNull();
    }
  });

  it('serves a Scanned cover and avatar to a visitor', async () => {
    setUser('Scanned');
    const user = await getUserWithProfile({ id: OWNER });

    expect(user.profile.coverImage?.url).toBe('cover-Scanned');
    expect(user.profilePicture?.url).toBe('avatar-Scanned');
  });

  it.each([
    ['the owner', { sessionUserId: OWNER }],
    ['a moderator', { sessionUserId: VISITOR, isModerator: true }],
  ])('serves %s their unscanned cover and avatar', async (_, viewer) => {
    setUser('Pending');
    const user = await getUserWithProfile({ id: OWNER, ...viewer });

    expect(user.profile.coverImage?.url).toBe('cover-Pending');
    expect(user.profilePicture?.url).toBe('avatar-Pending');
  });
});

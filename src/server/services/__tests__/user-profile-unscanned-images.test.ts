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

const kysely = vi.hoisted(() => ({ on: false, user: undefined as unknown }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: vi.fn(async () => kysely.on),
}));
vi.mock('~/server/services/hot-reads-9.reads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserWithProfileViaKysely: vi.fn(async () => kysely.user),
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

function setUser(ingestion: string, { pictureNulled = false } = {}) {
  const row = {
    id: OWNER,
    username: 'creator',
    meta: {},
    settings: {},
    publicSettings: {},
    cosmetics: [],
    profilePicture: pictureNulled ? null : picture(ingestion),
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
  };
  dbMock.dbWrite.user.findUniqueOrThrow.mockResolvedValue(row as never);
  kysely.user = row;
}

beforeEach(() => {
  vi.clearAllMocks();
  kysely.on = false;
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

  it('reads back an unscanned avatar the Prisma read nulled, for its owner and moderators only', async () => {
    // The find query nulls an unscanned picture for everyone; the owner's view re-reads it raw.
    setUser('Pending', { pictureNulled: true });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([picture('Pending')] as never);

    const owner = await getUserWithProfile({ id: OWNER, sessionUserId: OWNER });
    expect(owner.profilePicture?.url).toBe('avatar-Pending');

    dbMock.dbWrite.$queryRaw.mockClear();
    const visitor = await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR });
    expect(visitor.profilePicture).toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('reads back the unscanned avatar for a moderator too', async () => {
    setUser('Pending', { pictureNulled: true });
    dbMock.dbWrite.$queryRaw.mockResolvedValue([picture('Pending')] as never);

    const user = await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR, isModerator: true });
    expect(user.profilePicture?.url).toBe('avatar-Pending');
  });

  it('on the Kysely read, serves the owner their unscanned avatar and withholds it from a visitor', async () => {
    // The Kysely read keeps the unscanned picture for the service to gate; no raw re-read.
    kysely.on = true;
    setUser('Pending');

    const owner = await getUserWithProfile({ id: OWNER, sessionUserId: OWNER });
    const visitor = await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR });

    expect(owner.profilePicture?.url).toBe('avatar-Pending');
    expect(visitor.profilePicture).toBeNull();
    expect(visitor.profile.coverImage).toBeNull();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

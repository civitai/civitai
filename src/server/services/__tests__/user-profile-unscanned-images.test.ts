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

const kysely = vi.hoisted(() => ({
  on: false,
  user: undefined as unknown,
  pictureBlockedFor: null as string | null,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: vi.fn(async () => kysely.on),
}));
vi.mock('~/server/services/hot-reads-9.reads', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUserWithProfileAndPictureGateViaKysely: vi.fn(async () => ({
    user: kysely.user,
    pictureBlockedFor: kysely.pictureBlockedFor,
  })),
}));

import { getUserWithProfile } from '~/server/services/user-profile.service';

const OWNER = 77;
const VISITOR = 88;

const cover = (ingestion: string) => ({
  id: 1,
  url: `cover-${ingestion}`,
  nsfwLevel: 1,
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

function setUser(
  ingestion: string,
  {
    pictureNulled = false,
    pictureNsfwLevel = 1,
    coverFields = {},
  }: {
    pictureNulled?: boolean;
    pictureNsfwLevel?: number;
    coverFields?: {
      nsfwLevel?: number;
      modelRestricted?: boolean | null;
      blockedFor?: string | null;
    };
  } = {}
) {
  const row = {
    id: OWNER,
    username: 'creator',
    meta: {},
    settings: {},
    publicSettings: {},
    cosmetics: [],
    profilePicture: pictureNulled ? null : { ...picture(ingestion), nsfwLevel: pictureNsfwLevel },
    profile: {
      userId: OWNER,
      privacySettings: {},
      profileSectionsSettings: [],
      showcaseItems: [],
      coverImageId: 1,
      coverImage: { ...cover(ingestion), ...coverFields },
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
  kysely.pictureBlockedFor = null;
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

  it('withholds an unrated cover from a visitor and serves it to its owner', async () => {
    setUser('Scanned');
    (
      kysely.user as { profile: { coverImage: { nsfwLevel: number } } }
    ).profile.coverImage.nsfwLevel = 0;

    const visitor = await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR });
    const owner = await getUserWithProfile({ id: OWNER, sessionUserId: OWNER });

    expect(visitor.profile.coverImage).toBeNull();
    expect(owner.profile.coverImage?.url).toBe('cover-Scanned');
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

// A mature picture made with a base model that restricts mature images is its uploader's alone:
// moderators included. The flag is looked up per picture, and only for a mature one.
describe('getUserWithProfile — model-restricted avatar', () => {
  const R = 4;
  const restricted = (modelRestricted: boolean | null) =>
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      (modelRestricted === null ? null : { modelRestricted }) as never
    );
  const viewers = {
    visitor: { sessionUserId: VISITOR },
    moderator: { sessionUserId: VISITOR, isModerator: true },
    owner: { sessionUserId: OWNER },
  };
  const avatarFor = async (viewer: keyof typeof viewers) =>
    (await getUserWithProfile({ id: OWNER, ...viewers[viewer] })).profilePicture?.url ?? null;

  it('withholds a restricted mature avatar from a visitor and a moderator, not the owner', async () => {
    setUser('Scanned', { pictureNsfwLevel: R });
    restricted(true);

    expect(await avatarFor('visitor')).toBeNull();
    expect(await avatarFor('moderator')).toBeNull();
    expect(await avatarFor('owner')).toBe('avatar-Scanned');
  });

  it('serves an unrestricted mature avatar to a visitor and a moderator', async () => {
    setUser('Scanned', { pictureNsfwLevel: R });
    restricted(false);

    expect(await avatarFor('visitor')).toBe('avatar-Scanned');
    expect(await avatarFor('moderator')).toBe('avatar-Scanned');
  });

  it('counts a mature avatar whose image row is missing as restricted', async () => {
    setUser('Scanned', { pictureNsfwLevel: R });
    restricted(null);

    expect(await avatarFor('visitor')).toBeNull();
    expect(await avatarFor('moderator')).toBeNull();
  });

  it('never looks up the flag for a SFW avatar', async () => {
    setUser('Scanned', { pictureNsfwLevel: 1 });
    restricted(true);

    expect(await avatarFor('visitor')).toBe('avatar-Scanned');
    expect(await avatarFor('moderator')).toBe('avatar-Scanned');
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });
});

// The cover follows the avatar's rule: a restricted mature cover is its uploader's alone.
describe('getUserWithProfile — model-restricted cover', () => {
  const R = 4;
  const visitor = { sessionUserId: VISITOR };
  const moderator = { sessionUserId: VISITOR, isModerator: true };
  const owner = { sessionUserId: OWNER };
  const coverFor = async (viewer: { sessionUserId: number; isModerator?: boolean }) =>
    (await getUserWithProfile({ id: OWNER, ...viewer })).profile.coverImage?.url ?? null;

  it('withholds a restricted mature cover from a visitor and a moderator, not the owner', async () => {
    setUser('Scanned', { coverFields: { nsfwLevel: R, modelRestricted: true } });

    expect(await coverFor(visitor)).toBeNull();
    expect(await coverFor(moderator)).toBeNull();
    expect(await coverFor(owner)).toBe('cover-Scanned');
  });

  it('serves an unrestricted mature cover to a visitor and a moderator', async () => {
    setUser('Scanned', { coverFields: { nsfwLevel: R, modelRestricted: false } });

    expect(await coverFor(visitor)).toBe('cover-Scanned');
    expect(await coverFor(moderator)).toBe('cover-Scanned');
  });
});

describe('getUserWithProfile — blocked cover, for its owner', () => {
  const owner = { sessionUserId: OWNER };
  const moderator = { sessionUserId: VISITOR, isModerator: true };
  const coverFor = async (viewer: { sessionUserId: number; isModerator?: boolean }) =>
    (await getUserWithProfile({ id: OWNER, ...viewer })).profile.coverImage?.url ?? null;

  it.each(['tos', 'moderated'])('gives the owner no cover blocked for %s', async (blockedFor) => {
    setUser('Blocked', { coverFields: { blockedFor } });

    expect(await coverFor(owner)).toBeNull();
    expect(await coverFor(moderator)).toBe('cover-Blocked');
  });

  it('gives the owner no cover with a Blocked ingestion and no reason', async () => {
    setUser('Blocked');

    expect(await coverFor(owner)).toBeNull();
  });

  it('keeps the cover for its owner under a metadata hold only', async () => {
    setUser('Blocked', { coverFields: { blockedFor: 'AiNotVerified' } });

    expect(await coverFor(owner)).toBe('cover-Blocked');
  });
});

// The Kysely profile read returns the picture's block reason beside the payload; a picture carrying
// one is no one's avatar but its owner's and moderators'.
describe('getUserWithProfile — avatar with a block reason, on the Kysely read', () => {
  it('withholds it from a visitor, not the owner or a moderator, with no extra read', async () => {
    kysely.on = true;
    kysely.pictureBlockedFor = 'tos';
    setUser('Scanned');

    const avatarFor = async (sessionUserId: number, isModerator = false) =>
      (await getUserWithProfile({ id: OWNER, sessionUserId, isModerator })).profilePicture?.url ??
      null;
    expect(await avatarFor(VISITOR)).toBeNull();
    expect(await avatarFor(OWNER)).toBe('avatar-Scanned');
    expect(await avatarFor(VISITOR, true)).toBe('avatar-Scanned');
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });

  it('serves one without a block reason', async () => {
    kysely.on = true;
    setUser('Scanned');

    expect(
      (await getUserWithProfile({ id: OWNER, sessionUserId: VISITOR })).profilePicture?.url
    ).toBe('avatar-Scanned');
  });
});

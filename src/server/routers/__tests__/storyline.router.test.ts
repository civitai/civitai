import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';

/**
 * Storyline reads through the router, as a reader gets them: the flag gate, the reader's browsing
 * level (held to the domain cap) and the story-level gate together. A story whose first chapter is
 * outside the reader's level serves nothing of itself, not even its title; a chapter by someone
 * the reader blocked or hid is a tombstone.
 */

const { getBlockedPairIds, hiddenUsersCached } = vi.hoisted(() => ({
  getBlockedPairIds: vi.fn(),
  hiddenUsersCached: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  // Straight through to the origin.
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
  setFetchThroughCache: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds,
  HiddenUsers: {
    ...(await importOriginal<typeof UserPreferencesService>()).HiddenUsers,
    getCached: hiddenUsersCached,
  },
}));

import { storylineRouter } from '~/server/routers/storyline.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 1;
const READER = 50;
const AUTHOR = 7;

const r = dbMock.dbRead;

/** A signed-in reader granted the storylines flag, on a domain that allows mature content. */
function callerFor(
  userId: number,
  permissions: string[] = ['storylines'],
  user: Record<string, unknown> = {}
) {
  return storylineRouter.createCaller({
    user: {
      id: userId,
      permissions,
      showNsfw: true,
      browsingLevel: NsfwLevel.PG,
      // Onboarded, so the write procedures' guards let the call reach the service.
      onboarding: OnboardingSteps.Buzz,
      ...user,
    },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true, isGreen: false },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

const notBanned = { bannedAt: null, deletedAt: null };

const xStory = {
  id: 10,
  userId: OWNER,
  title: 'A mature story',
  status: 'Ongoing',
  maxNsfwLevel: NsfwLevel.X,
  tosViolation: false,
  nsfwLevel: 0,
  moderatorNsfwLevel: null,
  createdAt: new Date('2026-10-01'),
  user: { id: OWNER, username: 'owner', ...notBanned },
  chapters: [{ id: 1, postId: 101, post: { nsfwLevel: NsfwLevel.X } }],
  collaborators: [],
};

const post = (id: number, userId: number, nsfwLevel: number = NsfwLevel.PG) => ({
  id,
  userId,
  title: `post ${id}`,
  nsfwLevel,
  publishedAt: new Date('2026-10-01'),
  tosViolation: false,
  user: { username: `u${userId}`, ...notBanned },
});

beforeEach(() => {
  resetSharedMocks();
  getBlockedPairIds.mockReset();
  getBlockedPairIds.mockResolvedValue([]);
  hiddenUsersCached.mockReset();
  hiddenUsersCached.mockResolvedValue([]);
});

describe('storyline router: a story outside the reader’s level serves nothing of itself', () => {
  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(xStory as never);
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 1 } as never);
    r.$queryRaw.mockResolvedValue([
      { id: 1, postId: 101, depth: 0, parentIds: [] },
      { id: 2, postId: 102, depth: 1, parentIds: [] },
    ] as never);
    r.post.findMany.mockResolvedValue([post(101, OWNER, NsfwLevel.X), post(102, OWNER)] as never);
    r.storylineChapter.findMany.mockResolvedValue([
      {
        id: 2,
        postId: 102,
        depth: 1,
        // A PG chapter deep inside the X story.
        post: { nsfwLevel: NsfwLevel.PG, tosViolation: false, user: notBanned },
        storyline: { ...xStory, user: notBanned },
      },
    ] as never);
  });

  it('refuses the header, the path and the forks, and leaves the post out of the lookup', async () => {
    const caller = callerFor(READER);
    const pg = { browsingLevel: NsfwLevel.PG };
    await expect(caller.getById({ id: 10, ...pg })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller.getPath({ chapterId: 2, ...pg })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.getChildren({ chapterId: 2, ...pg })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.getForPosts({ postIds: [102], ...pg })).resolves.toEqual({});
  });

  it('serves all of it to a reader whose level includes the story', async () => {
    const caller = callerFor(READER);
    const withX = { browsingLevel: NsfwLevel.PG | NsfwLevel.X };
    await expect(caller.getById({ id: 10, ...withX })).resolves.toMatchObject({
      title: 'A mature story',
    });
    await expect(caller.getPath({ chapterId: 2, ...withX })).resolves.toMatchObject({
      storyline: { title: 'A mature story' },
    });
    await expect(caller.getForPosts({ postIds: [102], ...withX })).resolves.toEqual({
      102: { chapterId: 2, depth: 1, storylineId: 10, title: 'A mature story' },
    });
  });
});

describe('storyline router: chapters by people the reader blocked or hid', () => {
  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue({
      ...xStory,
      maxNsfwLevel: NsfwLevel.R,
      chapters: [{ id: 1, postId: 101, post: { nsfwLevel: NsfwLevel.PG } }],
    } as never);
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 1 } as never);
    r.$queryRaw.mockResolvedValue([
      { id: 1, postId: 101, depth: 0, parentIds: [] },
      { id: 2, postId: 102, depth: 1, parentIds: [] },
    ] as never);
    r.post.findMany.mockResolvedValue([post(101, OWNER), post(102, AUTHOR)] as never);
  });

  const pathTombstones = async () =>
    (await callerFor(READER).getPath({ chapterId: 2, browsingLevel: NsfwLevel.PG })).chapters.map(
      (c) => c.tombstone
    );

  it('shows the chapter when the reader has neither blocked nor hidden its author', async () => {
    expect(await pathTombstones()).toEqual([null, null]);
  });

  it('tombstones the chapter of an author the reader hid', async () => {
    hiddenUsersCached.mockResolvedValue([{ id: AUTHOR }]);
    expect(await pathTombstones()).toEqual([null, 'unavailable']);
    expect(hiddenUsersCached).toHaveBeenCalledWith({ userId: READER });
  });

  it('tombstones the chapter of an author in a block with the reader', async () => {
    getBlockedPairIds.mockResolvedValue([AUTHOR]);
    expect(await pathTombstones()).toEqual([null, 'unavailable']);
    expect(getBlockedPairIds).toHaveBeenCalledWith(READER);
  });
});

// A profile's Storylines tab is this feed narrowed to one owner, under the feed's own gates.
describe("storyline router: the feed narrowed to one owner's storylines", () => {
  const ownerClauses = async (input: { userId?: number }) => {
    r.$queryRaw.mockReset();
    r.$queryRaw.mockResolvedValue([] as never);
    await callerFor(READER).getInfinite({ filter: 'all', sort: 'newest', ...input });
    const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const composed = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    return (composed.sql.match(/st\."userId" = \?/g) ?? []).length;
  };

  it('adds the owner to the feed query, and only when asked', async () => {
    const without = await ownerClauses({});
    expect(await ownerClauses({ userId: OWNER })).toBe(without + 1);
  });
});

describe('storyline router: flag', () => {
  it('refuses a reader without the storylines flag', async () => {
    r.storyline.findUnique.mockResolvedValue(xStory as never);
    await expect(
      callerFor(READER, []).getById({ id: 10, browsingLevel: NsfwLevel.X })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('storyline router: who may call the engagement procedures', () => {
  function signedOut() {
    return storylineRouter.createCaller({
      user: undefined,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: { canViewNsfw: true, isGreen: false },
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never);
  }

  it('refuses signed-out readers every write and the sign-up status', async () => {
    const caller = signedOut();
    await expect(
      caller.trackBranchChoice({ fromChapterId: 1, toChapterId: 2 })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.trackCreateClick({ chapterId: 1 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(caller.joinEarlyAccess({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.getEarlyAccessStatus()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.storylineBranchChoice.upsert).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.storylineCreateClick.upsert).not.toHaveBeenCalled();
  });

  it('shows early-access numbers to moderators only', async () => {
    await expect(callerFor(READER).getEarlyAccessStats()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it("records a signed-in reader's choice as theirs", async () => {
    dbMock.dbWrite.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    r.storyline.findUnique.mockResolvedValue({
      ...xStory,
      chapters: [{ id: 1, postId: 101, post: { nsfwLevel: NsfwLevel.PG } }],
    } as never);
    dbMock.dbWrite.storylineChapterEdge.findUnique.mockResolvedValue({ chapterId: 2 } as never);
    await callerFor(READER).trackBranchChoice({
      fromChapterId: 1,
      toChapterId: 2,
      browsingLevel: NsfwLevel.PG,
    });
    expect(dbMock.dbWrite.storylineBranchChoice.upsert.mock.calls[0][0]).toMatchObject({
      create: { userId: READER, parentChapterId: 1, chapterId: 2 },
    });
  });
});

describe('storyline router: canon ahead', () => {
  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(xStory as never);
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    // The canon walk; the chapters' first images are none.
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(
        // The walk is a nested fragment, so the SQL is read composed.
        Prisma.sql(strings, ...(values as Prisma.Sql[])).sql.includes('WITH RECURSIVE main')
          ? [
              { id: 2, postId: 102, depth: 1, parentIds: [] },
              { id: 3, postId: 103, depth: 2, parentIds: [] },
            ]
          : []
      )) as never);
    r.post.findMany.mockResolvedValue([post(102, OWNER), post(103, AUTHOR)] as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([] as never);
  });

  it('refuses a reader whose level does not include the story', async () => {
    await expect(
      callerFor(READER).getCanonAhead({ chapterId: 2, browsingLevel: NsfwLevel.PG })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serves the canon after the chapter to a reader whose level includes the story', async () => {
    await expect(
      callerFor(READER).getCanonAhead({ chapterId: 2, browsingLevel: NsfwLevel.PG | NsfwLevel.X })
    ).resolves.toEqual([
      {
        chapterId: 3,
        depth: 2,
        tombstone: null,
        post: {
          id: 103,
          title: 'post 103',
          userId: AUTHOR,
          username: `u${AUTHOR}`,
          user: { username: `u${AUTHOR}` },
        },
        childCount: 0,
        joins: [],
        parentCount: 0,
        firstImage: null,
      },
    ]);
  });

  it('refuses a reader without the storylines flag', async () => {
    await expect(
      callerFor(READER, []).getCanonAhead({ chapterId: 2, browsingLevel: NsfwLevel.X })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('storyline router: chapter levels and the ceiling floor', () => {
  const w = dbMock.dbWrite;
  const shownChapter = {
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    ...notBanned,
  };

  beforeEach(() => {
    w.storyline.findUnique.mockResolvedValue(xStory as never);
    r.$queryRaw.mockResolvedValue([
      { depth: 0, userId: OWNER, nsfwLevel: NsfwLevel.X, ...shownChapter },
      { depth: 1, userId: AUTHOR, nsfwLevel: NsfwLevel.PG, ...shownChapter },
    ] as never);
  });

  it('gives the owner the chapter levels', async () => {
    await expect(callerFor(OWNER).getChapterLevels({ id: 10 })).resolves.toEqual({
      rootNsfwLevel: NsfwLevel.X,
      chapterLevels: [NsfwLevel.PG],
    });
  });

  it('refuses a reader who is not the owner, and anyone signed out', async () => {
    await expect(callerFor(READER).getChapterLevels({ id: 10 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const signedOut = storylineRouter.createCaller({
      user: undefined,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: { canViewNsfw: true, isGreen: false },
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never);
    await expect(signedOut.getChapterLevels({ id: 10 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(r.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses the owner a ceiling below chapter 1, and allows one at it', async () => {
    w.storyline.findUnique.mockResolvedValue({ ...xStory, maxNsfwLevel: NsfwLevel.XXX } as never);
    w.storylineChapter.findFirst.mockResolvedValue({
      post: { nsfwLevel: NsfwLevel.X, tosViolation: false },
    } as never);
    await expect(
      callerFor(OWNER).update({ id: 10, maxNsfwLevel: NsfwLevel.R })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(w.storyline.update).not.toHaveBeenCalled();
    w.storyline.update.mockResolvedValue(xStory as never);
    await callerFor(OWNER).update({ id: 10, maxNsfwLevel: NsfwLevel.X });
    expect(w.storyline.update).toHaveBeenCalledTimes(1);
  });
});

describe('storyline router: moderating a title', () => {
  it('is for moderators only, the owner included', async () => {
    dbMock.dbWrite.storyline.findUnique.mockResolvedValue({ tosViolationByScan: true } as never);
    await expect(
      callerFor(OWNER).moderateTitle({ id: 10, liftScanTakedown: { reviewedTitle: 'A' } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(dbMock.dbWrite.storyline.updateMany).not.toHaveBeenCalled();
  });

  const moderator = () => callerFor(99, [], { isModerator: true });

  it('reaches the service for a moderator', async () => {
    dbMock.dbWrite.storyline.findUnique.mockResolvedValue({ tosViolationByScan: false } as never);
    dbMock.dbWrite.storyline.updateMany.mockResolvedValue({ count: 1 } as never);
    await moderator().moderateTitle({ id: 10, moderatorNsfwLevel: NsfwLevel.R });
    expect(dbMock.dbWrite.storyline.updateMany).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { moderatorNsfwLevel: NsfwLevel.R },
    });
  });

  it.each([
    ['nothing to change', { id: 10 }],
    ['a lift without the reviewed title', { id: 10, liftScanTakedown: {} }],
    ['a rating that is not one level', { id: 10, moderatorNsfwLevel: 0 }],
  ])('refuses %s before the service', async (_name, input) => {
    await expect(moderator().moderateTitle(input as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(dbMock.dbWrite.storyline.findUnique).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Storyline reads through the router, as a reader gets them: the flag gate, the reader's browsing
 * level (held to the domain cap) and the story-level gate together. A story whose first chapter is
 * outside the reader's level serves nothing of itself, not even its title; a chapter by someone
 * the reader blocked or hid is a tombstone.
 */

const { getBlockedPairIds, getAllHiddenForUser } = vi.hoisted(() => ({
  getBlockedPairIds: vi.fn(),
  getAllHiddenForUser: vi.fn(),
}));
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds,
  getAllHiddenForUser,
}));

import { storylineRouter } from '~/server/routers/storyline.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const OWNER = 1;
const READER = 50;
const AUTHOR = 7;

const r = dbMock.dbRead;

/** A signed-in reader granted the storylines flag, on a domain that allows mature content. */
function callerFor(userId: number, permissions: string[] = ['storylines']) {
  return storylineRouter.createCaller({
    user: { id: userId, permissions, showNsfw: true, browsingLevel: NsfwLevel.PG },
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

/** A storyline whose first chapter is rated X, with a ceiling of X. */
const xStory = {
  id: 10,
  userId: OWNER,
  title: 'A mature story',
  status: 'Ongoing',
  maxNsfwLevel: NsfwLevel.X,
  tosViolation: false,
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
  getAllHiddenForUser.mockReset();
  getAllHiddenForUser.mockResolvedValue({ hiddenUsers: [] });
});

describe('storyline router: a story outside the reader’s level serves nothing of itself', () => {
  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(xStory as never);
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 1 } as never);
    r.$queryRaw.mockResolvedValue([
      { id: 1, postId: 101, depth: 0 },
      { id: 2, postId: 102, depth: 1 },
    ] as never);
    r.post.findMany.mockResolvedValue([post(101, OWNER, NsfwLevel.X), post(102, OWNER)] as never);
    r.storylineChapter.findMany.mockResolvedValue([
      {
        id: 2,
        postId: 102,
        depth: 1,
        // A PG chapter deep inside the X story.
        post: { nsfwLevel: NsfwLevel.PG },
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
      { id: 1, postId: 101, depth: 0 },
      { id: 2, postId: 102, depth: 1 },
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
    getAllHiddenForUser.mockResolvedValue({ hiddenUsers: [{ id: AUTHOR }] });
    expect(await pathTombstones()).toEqual([null, 'unavailable']);
    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: READER });
  });

  it('tombstones the chapter of an author in a block with the reader', async () => {
    getBlockedPairIds.mockResolvedValue([AUTHOR]);
    expect(await pathTombstones()).toEqual([null, 'unavailable']);
    expect(getBlockedPairIds).toHaveBeenCalledWith(READER);
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

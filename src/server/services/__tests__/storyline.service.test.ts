import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';

const {
  enforceBlockedBrowsingTags,
  getAllHiddenForUser,
  getBlockedPairIds,
  hiddenUsersCached,
  placementPriceRanges,
} = vi.hoisted(() => ({
  enforceBlockedBrowsingTags: vi.fn(),
  getAllHiddenForUser: vi.fn(),
  getBlockedPairIds: vi.fn(),
  hiddenUsersCached: vi.fn(),
  placementPriceRanges: vi.fn(),
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  // Straight through to the origin; caching is not what these tests are about.
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
  bustFetchThroughCache,
}));
const bustFetchThroughCache = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getAllHiddenForUser,
  getBlockedPairIds,
  HiddenUsers: {
    ...(await importOriginal<typeof UserPreferencesService>()).HiddenUsers,
    getCached: hiddenUsersCached,
  },
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTags,
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  placementPriceRanges,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(),
}));

import {
  addOwnerChapter,
  addStorylineCollaborator,
  createStoryline,
  getStoryline,
  getStorylineCanonAhead,
  getStorylineChapterLevels,
  getStorylineChildren,
  getStorylinePath,
  getStorylineForkShares,
  getStorylinesForPosts,
  getStorylineEarlyAccessStats,
  getStorylineEarlyAccessStatus,
  getStorylinesInfinite,
  joinStorylineEarlyAccess,
  recordStorylineBranchChoice,
  recordStorylineCreateClick,
  removeStorylineCollaborator,
  setCanonChapter,
  updateStoryline,
  writeChapterEdgeForPlacement,
} from '~/server/services/storyline.service';

const OWNER = 1;
const COLLABORATOR = 2;
const STRANGER = 3;
const BLOCKED = 4;
const MODERATOR = 5;
const PARENT_AUTHOR = 8;
const AUTHOR_OF_POSTS = 9;

const w = dbMock.dbWrite;
const r = dbMock.dbRead;
/** The approve transaction's client, as the placement layer passes it. */
const tx = w as never;

const notBanned = { bannedAt: null, deletedAt: null };

const storylineRow = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  userId: OWNER,
  title: 'A story',
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  maxNsfwLevel: NsfwLevel.R,
  tosViolation: false,
  createdAt: new Date('2026-10-01'),
  user: { id: OWNER, username: 'owner', ...notBanned },
  // Chapter 1, PG: inside every reader level used here unless a test says otherwise.
  chapters: [{ id: 1, postId: 101, post: { nsfwLevel: NsfwLevel.PG } }],
  ...overrides,
});

const publishedPost = (overrides: Record<string, unknown> = {}) => ({
  userId: STRANGER,
  nsfwLevel: NsfwLevel.PG,
  publishedAt: new Date('2026-10-01'),
  tosViolation: false,
  storylineChapter: null,
  ...overrides,
});

/**
 * The primary-read block check is a raw query on "UserEngagement" with the two ids as values.
 * This answers it from a list of blocked pairs, so a check made with the wrong ids, or not made,
 * gives a different answer than one made with the right ones.
 */
let blockedPairs: Array<[number, number]> = [];
const answerRaw = (client: { $queryRaw: { mockImplementation: (f: never) => unknown } }) =>
  client.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join('?').includes('"UserEngagement"')) return Promise.resolve([]);
    const [a, b] = values as number[];
    const exists = blockedPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    return Promise.resolve([{ exists }]);
  }) as never);

beforeEach(() => {
  // The shared db mock is otherwise reset only between files; these tests must not share call
  // counts or implementations.
  resetSharedMocks();
  getBlockedPairIds.mockReset();
  getBlockedPairIds.mockResolvedValue([]);
  hiddenUsersCached.mockReset();
  hiddenUsersCached.mockResolvedValue([]);
  getAllHiddenForUser.mockReset();
  getAllHiddenForUser.mockResolvedValue({ hiddenImages: [], hiddenTags: [] });
  placementPriceRanges.mockReset();
  placementPriceRanges.mockResolvedValue(new Map());
  enforceBlockedBrowsingTags.mockReset();
  enforceBlockedBrowsingTags.mockResolvedValue({ emptyResult: false });
  bustFetchThroughCache.mockReset();
  blockedPairs = [];
  answerRaw(w);
});

describe('writeChapterEdgeForPlacement', () => {
  const args = { placementId: 77, parentPostId: 500, postId: 600, placerId: STRANGER };

  const parentChapter = {
    id: 20,
    storylineId: 10,
    depth: 2,
    userId: PARENT_AUTHOR,
    storyline: {
      userId: OWNER,
      maxNsfwLevel: NsfwLevel.R,
      tosViolation: false,
      whoCanContinue: 'Anyone',
    },
  };

  const findChapter = (parent: unknown) =>
    (({ where }: { where: { placementId?: number; postId?: number } }) =>
      Promise.resolve(where.postId === args.parentPostId ? parent : null)) as never;

  const findByPlacement = (row: unknown) =>
    (({ where }: { where: { placementId?: number } }) =>
      Promise.resolve(where.placementId === args.placementId ? row : null)) as never;

  beforeEach(() => {
    w.storylineChapter.findUnique.mockImplementation(findChapter(parentChapter));
    w.post.findUnique.mockResolvedValue(publishedPost() as never);
    w.storylineChapter.create.mockResolvedValue({ id: 30 } as never);
    w.storylineChapterEdge.create.mockResolvedValue({} as never);
  });

  it('writes one chapter one level below its parent, with an edge to the parent CHAPTER', async () => {
    await expect(writeChapterEdgeForPlacement(args, tx)).resolves.toEqual({
      chapterId: 30,
      created: true,
    });
    expect(w.storylineChapter.create).toHaveBeenCalledTimes(1);
    expect(w.storylineChapter.create.mock.calls[0][0]).toMatchObject({
      data: { storylineId: 10, postId: 600, userId: STRANGER, depth: 3, placementId: 77 },
    });
    expect(w.storylineChapterEdge.create).toHaveBeenCalledTimes(1);
    expect(w.storylineChapterEdge.create.mock.calls[0][0]).toEqual({
      data: { storylineId: 10, chapterId: 30, parentChapterId: 20, canon: false },
    });
  });

  it('is replay safe: a second call for the same placement writes nothing', async () => {
    w.storylineChapter.findUnique.mockImplementation(findByPlacement({ id: 30, postId: 600 }));
    await expect(writeChapterEdgeForPlacement(args, tx)).resolves.toEqual({
      chapterId: 30,
      created: false,
    });
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(w.storylineChapterEdge.create).not.toHaveBeenCalled();
  });

  it('refuses a replay that names a different post', async () => {
    w.storylineChapter.findUnique.mockImplementation(findByPlacement({ id: 30, postId: 999 }));
    await expect(writeChapterEdgeForPlacement(args, tx)).rejects.toThrow(/different post/);
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
  });

  it("marks the owner's continuation canon only when the parent has no canon child", async () => {
    let canonTaken = false;
    w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
    w.storylineChapterEdge.findFirst.mockImplementation((({
      where,
    }: {
      where: { parentChapterId: number; canon: boolean };
    }) =>
      Promise.resolve(
        where.parentChapterId === 20 && where.canon && canonTaken ? { chapterId: 21 } : null
      )) as never);

    await writeChapterEdgeForPlacement({ ...args, placerId: OWNER }, tx);
    expect(w.storylineChapterEdge.create.mock.calls[0][0]).toMatchObject({ data: { canon: true } });

    canonTaken = true;
    await writeChapterEdgeForPlacement({ ...args, placerId: OWNER }, tx);
    expect(w.storylineChapterEdge.create.mock.calls[1][0]).toMatchObject({
      data: { canon: false },
    });
  });

  it.each([
    [
      'a parent that is not a chapter',
      () => w.storylineChapter.findUnique.mockResolvedValue(null as never),
      /not a chapter/,
    ],
    [
      'a placer in a block with the storyline owner',
      () => (blockedPairs = [[OWNER, STRANGER]]),
      /not available/,
    ],
    [
      'a placer in a block with the author of the chapter being continued',
      () => (blockedPairs = [[STRANGER, PARENT_AUTHOR]]),
      /not available/,
    ],
    [
      'a taken-down storyline',
      () =>
        w.storylineChapter.findUnique.mockImplementation(
          findChapter({
            ...parentChapter,
            storyline: { ...parentChapter.storyline, tosViolation: true },
          })
        ),
      /not a chapter of an open storyline/,
    ],
    [
      'a post above the ceiling',
      () => w.post.findUnique.mockResolvedValue(publishedPost({ nsfwLevel: NsfwLevel.X }) as never),
      /above/,
    ],
    [
      'an unrated post',
      () => w.post.findUnique.mockResolvedValue(publishedPost({ nsfwLevel: 0 }) as never),
      /not been rated/,
    ],
    [
      "someone else's post",
      () => w.post.findUnique.mockResolvedValue(publishedPost({ userId: BLOCKED }) as never),
      /your own posts/,
    ],
    [
      'an unpublished post',
      () => w.post.findUnique.mockResolvedValue(publishedPost({ publishedAt: null }) as never),
      /Publish/,
    ],
    [
      'a post scheduled for later',
      () =>
        w.post.findUnique.mockResolvedValue(
          publishedPost({ publishedAt: new Date(Date.now() + 86_400_000) }) as never
        ),
      /Publish/,
    ],
    [
      'a taken-down post',
      () => w.post.findUnique.mockResolvedValue(publishedPost({ tosViolation: true }) as never),
      /cannot be added/,
    ],
    [
      'a post already in a storyline',
      () =>
        w.post.findUnique.mockResolvedValue(
          publishedPost({ storylineChapter: { id: 1 } }) as never
        ),
      /already in a storyline/,
    ],
  ])('refuses %s with a client error and writes nothing', async (_name, arrange, message) => {
    arrange();
    const error = await writeChapterEdgeForPlacement(args, tx).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(message);
    // A refusal the approver can act on, not an internal error.
    expect((error as { code?: string }).code).toMatch(/^(BAD_REQUEST|UNAUTHORIZED|NOT_FOUND)$/);
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(w.storylineChapterEdge.create).not.toHaveBeenCalled();
  });

  describe('when only collaborators may continue', () => {
    beforeEach(() => {
      w.storylineChapter.findUnique.mockImplementation(
        findChapter({
          ...parentChapter,
          storyline: { ...parentChapter.storyline, whoCanContinue: 'Collaborators' },
        })
      );
    });

    it("refuses a stranger with the placement layer's refusal", async () => {
      await expect(writeChapterEdgeForPlacement(args, tx)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'storyline: only collaborators on this storyline can continue it',
      });
      expect(w.storylineChapter.create).not.toHaveBeenCalled();
    });

    it('lets the owner continue without being a collaborator', async () => {
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
      await expect(
        writeChapterEdgeForPlacement({ ...args, placerId: OWNER }, tx)
      ).resolves.toMatchObject({ created: true });
    });

    it('lets an endorsed collaborator continue', async () => {
      w.storylineCollaborator.findUnique.mockImplementation((({
        where,
      }: {
        where: { storylineId_userId: { storylineId: number; userId: number } };
      }) =>
        Promise.resolve(
          where.storylineId_userId.storylineId === 10 &&
            where.storylineId_userId.userId === STRANGER
            ? { userId: STRANGER }
            : null
        )) as never);
      await expect(writeChapterEdgeForPlacement(args, tx)).resolves.toMatchObject({
        created: true,
      });
    });
  });

  it('refuses a chapter continuing itself', async () => {
    await expect(writeChapterEdgeForPlacement({ ...args, postId: 500 }, tx)).rejects.toThrow(
      /continue itself/
    );
  });

  it('runs every read and write on the client it is handed', async () => {
    const tx = {
      storylineChapter: {
        findUnique: vi.fn(findChapter(parentChapter)),
        create: vi.fn().mockResolvedValue({ id: 31 }),
      },
      storylineChapterEdge: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      storylineCollaborator: { findUnique: vi.fn().mockResolvedValue(null) },
      post: { findUnique: vi.fn().mockResolvedValue(publishedPost({ userId: OWNER })) },
      $queryRaw: vi.fn(),
    };
    answerRaw(tx as never);
    // The owner continuing, so the canon branch (lock, canon lookup) runs too.
    await writeChapterEdgeForPlacement({ ...args, placerId: OWNER }, tx as never);
    expect(tx.post.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.storylineChapterEdge.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.storylineChapter.create).toHaveBeenCalledTimes(1);
    expect(tx.storylineChapterEdge.create).toHaveBeenCalledTimes(1);
    // The parent-author block check and the parent lock (the owner placing on their own
    // storyline skips the owner check).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(w.post.findUnique).not.toHaveBeenCalled();
    expect(w.storylineChapterEdge.findFirst).not.toHaveBeenCalled();
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(w.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('createStoryline', () => {
  beforeEach(() => {
    w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
    w.storyline.create.mockResolvedValue({ id: 10 } as never);
  });

  it('starts the storyline with the post as its first chapter', async () => {
    w.storylineChapter.create.mockResolvedValue({ id: 20 } as never);
    await expect(
      createStoryline({ postId: 500, title: 't', maxNsfwLevel: NsfwLevel.R, userId: OWNER })
    ).resolves.toEqual({ id: 10, rootChapterId: 20 });
    expect(w.storylineChapter.create.mock.calls[0][0]).toMatchObject({
      data: { storylineId: 10, postId: 500, userId: OWNER, depth: 0 },
    });
  });

  it('turns a lost race on the same post into a 400, not a 500', async () => {
    w.storylineChapter.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) as never
    );
    await expect(
      createStoryline({ postId: 500, title: 't', maxNsfwLevel: NsfwLevel.R, userId: OWNER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This post is already in a storyline',
    });
  });

  it("refuses wrapping someone else's post", async () => {
    w.post.findUnique.mockResolvedValue(publishedPost({ userId: STRANGER }) as never);
    await expect(
      createStoryline({ postId: 500, title: 't', maxNsfwLevel: NsfwLevel.R, userId: OWNER })
    ).rejects.toThrow(/your own posts/);
    expect(w.storyline.create).not.toHaveBeenCalled();
  });
});

describe('authorization', () => {
  const forbidden = { code: 'UNAUTHORIZED' };

  beforeEach(() => {
    w.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    w.storyline.update.mockResolvedValue(storylineRow() as never);
  });

  describe('updateStoryline', () => {
    it('lets the owner and a moderator edit', async () => {
      await updateStoryline({ id: 10, title: 'x', userId: OWNER });
      await updateStoryline({ id: 10, title: 'x', userId: MODERATOR, isModerator: true });
      expect(w.storyline.update).toHaveBeenCalledTimes(2);
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
        where: { id: 10 },
        data: { title: 'x' },
      });
    });

    it.each([
      ['an endorsed collaborator', COLLABORATOR],
      ['a stranger', STRANGER],
      ['a blocked user', BLOCKED],
    ])('refuses %s', async (_name, userId) => {
      await expect(updateStoryline({ id: 10, title: 'x', userId })).rejects.toMatchObject(
        forbidden
      );
      expect(w.storyline.update).not.toHaveBeenCalled();
    });

    it('lets the owner choose who can continue, and nobody else', async () => {
      await updateStoryline({ id: 10, whoCanContinue: 'Collaborators', userId: OWNER });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
        data: { whoCanContinue: 'Collaborators' },
      });
      for (const userId of [COLLABORATOR, STRANGER])
        await expect(
          updateStoryline({ id: 10, whoCanContinue: 'Anyone', userId })
        ).rejects.toMatchObject(forbidden);
      expect(w.storyline.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('addOwnerChapter', () => {
    beforeEach(() => {
      w.storylineChapter.findUnique.mockResolvedValue({
        id: 20,
        storylineId: 10,
        depth: 0,
        storyline: { userId: OWNER, maxNsfwLevel: NsfwLevel.R, tosViolation: false },
      } as never);
      w.storylineChapter.create.mockResolvedValue({ id: 30 } as never);
    });

    it('lets the owner continue directly', async () => {
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
      await expect(
        addOwnerChapter({ parentChapterId: 20, postId: 600, userId: OWNER })
      ).resolves.toEqual({ chapterId: 30 });
    });

    it.each([
      ['an endorsed collaborator', COLLABORATOR],
      ['a stranger', STRANGER],
    ])('refuses %s, who continues through a placement instead', async (_name, userId) => {
      w.post.findUnique.mockResolvedValue(publishedPost({ userId }) as never);
      await expect(
        addOwnerChapter({ parentChapterId: 20, postId: 600, userId })
      ).rejects.toMatchObject(forbidden);
      expect(w.storylineChapter.create).not.toHaveBeenCalled();
    });
  });

  describe('setCanonChapter', () => {
    beforeEach(() => {
      w.storylineChapterEdge.findFirst.mockResolvedValue({
        parentChapterId: 20,
        storylineId: 10,
      } as never);
    });

    it('moves canon for the owner: clears the old one, then sets the new one', async () => {
      await setCanonChapter({ chapterId: 31, userId: OWNER });
      expect(w.storylineChapterEdge.updateMany.mock.calls.map((c) => c[0])).toEqual([
        { where: { parentChapterId: 20, canon: true }, data: { canon: false } },
        { where: { chapterId: 31, parentChapterId: 20 }, data: { canon: true } },
      ]);
    });

    it.each([
      ['an endorsed collaborator', COLLABORATOR],
      ['a stranger', STRANGER],
    ])('refuses %s', async (_name, userId) => {
      await expect(setCanonChapter({ chapterId: 31, userId })).rejects.toMatchObject(forbidden);
      expect(w.storylineChapterEdge.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('collaborators', () => {
    beforeEach(() => {
      w.user.findUnique.mockResolvedValue({ id: COLLABORATOR, ...notBanned } as never);
      w.storylineCollaborator.count.mockResolvedValue(0 as never);
    });

    it('lets the owner endorse someone', async () => {
      await addStorylineCollaborator({
        storylineId: 10,
        targetUserId: COLLABORATOR,
        userId: OWNER,
      });
      expect(w.storylineCollaborator.upsert.mock.calls[0][0]).toMatchObject({
        create: { storylineId: 10, userId: COLLABORATOR },
      });
    });

    it('refuses a collaborator endorsing someone else', async () => {
      await expect(
        addStorylineCollaborator({ storylineId: 10, targetUserId: STRANGER, userId: COLLABORATOR })
      ).rejects.toMatchObject(forbidden);
      expect(w.storylineCollaborator.upsert).not.toHaveBeenCalled();
    });

    it('refuses endorsing a user in a block with the owner', async () => {
      blockedPairs = [[OWNER, BLOCKED]];
      await expect(
        addStorylineCollaborator({ storylineId: 10, targetUserId: BLOCKED, userId: OWNER })
      ).rejects.toThrow(/cannot endorse/);
      expect(w.storylineCollaborator.upsert).not.toHaveBeenCalled();
    });

    it('lets a collaborator step down, but not remove someone else', async () => {
      await removeStorylineCollaborator({
        storylineId: 10,
        targetUserId: COLLABORATOR,
        userId: COLLABORATOR,
      });
      expect(w.storylineCollaborator.deleteMany).toHaveBeenCalledTimes(1);

      await expect(
        removeStorylineCollaborator({
          storylineId: 10,
          targetUserId: COLLABORATOR,
          userId: STRANGER,
        })
      ).rejects.toMatchObject(forbidden);
      expect(w.storylineCollaborator.deleteMany).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getStoryline', () => {
  const PG = NsfwLevel.PG;
  const row = (overrides: Record<string, unknown> = {}, rootLevel: number = PG) => ({
    ...storylineRow(overrides),
    collaborators: [
      { user: { id: COLLABORATOR, username: 'c', ...notBanned } },
      { user: { id: BLOCKED, username: 'b', ...notBanned } },
      { user: { id: 6, username: 'gone', bannedAt: new Date(), deletedAt: null } },
    ],
    chapters: [{ id: 20, postId: 500, post: { nsfwLevel: rootLevel } }],
  });
  const banned = (field: 'bannedAt' | 'deletedAt') => ({
    user: { id: OWNER, username: 'o', ...notBanned, [field]: new Date() },
  });

  beforeEach(() => r.storyline.findUnique.mockResolvedValue(row() as never));

  it('is readable by a stranger and a signed-out reader', async () => {
    await expect(
      getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG })
    ).resolves.toMatchObject({ id: 10, rootChapterId: 20, rootPostId: 500 });
    await expect(
      getStoryline({ id: 10, viewer: undefined, browsingLevel: PG })
    ).resolves.toMatchObject({ id: 10 });
  });

  it('asks for the fields it hides on', async () => {
    await getStoryline({ id: 10, viewer: undefined, browsingLevel: PG });
    expect(r.storyline.findUnique.mock.calls[0][0]).toMatchObject({
      select: { tosViolation: true, user: { select: { bannedAt: true, deletedAt: true } } },
    });
  });

  it('leaves out collaborators in a block with the reader or banned, and never returns ban fields', async () => {
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
    const storyline = await getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG });
    expect(getBlockedPairIds).toHaveBeenCalledWith(STRANGER);
    expect(storyline.collaborators).toEqual([{ id: COLLABORATOR, username: 'c' }]);
    expect(storyline.user).toEqual({ id: OWNER, username: 'owner' });
  });

  it.each([
    ['in a block with the owner', row(), [OWNER]],
    ['taken down', row({ tosViolation: true }), []],
    ['owned by a banned user', row(banned('bannedAt')), []],
    ['owned by a deleted user', row(banned('deletedAt')), []],
    ["opening on a chapter outside the reader's level", row({}, NsfwLevel.X), []],
    // Chapter 1 unrated or gone: judged by the story's ceiling (R here), not waved through.
    ['opening on an unrated chapter in an R story', row({}, 0), []],
    [
      'whose chapter 1 is gone, in an R story',
      { ...row(), chapters: [{ id: 20, postId: null, post: null }] },
      [],
    ],
  ])(
    'is not found for a stranger when %s, but the owner and moderators still see it',
    async (_n, value, blocked) => {
      r.storyline.findUnique.mockResolvedValue(value as never);
      getBlockedPairIds.mockResolvedValue(blocked);
      await expect(
        getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      getBlockedPairIds.mockResolvedValue([]);
      await expect(
        getStoryline({ id: 10, viewer: { id: OWNER }, browsingLevel: PG })
      ).resolves.toMatchObject({ id: 10 });
      await expect(
        getStoryline({ id: 10, viewer: { id: MODERATOR, isModerator: true }, browsingLevel: PG })
      ).resolves.toMatchObject({ id: 10 });
    }
  );
});

describe('getStorylinesForPosts', () => {
  const chapter = (
    postId: number,
    overrides: Record<string, unknown> = {},
    level: number = NsfwLevel.PG
  ) => ({
    id: postId + 1000,
    postId,
    depth: 1,
    post: { nsfwLevel: level, userId: AUTHOR_OF_POSTS },
    storyline: {
      id: 10,
      title: 'A story',
      userId: OWNER,
      maxNsfwLevel: NsfwLevel.R,
      tosViolation: false,
      user: notBanned,
      chapters: [{ post: { nsfwLevel: NsfwLevel.PG } }],
      ...overrides,
    },
  });

  it('lists only stories this reader could open', async () => {
    r.storylineChapter.findMany.mockResolvedValue([
      chapter(1),
      chapter(2, { tosViolation: true }),
      chapter(3, {}, NsfwLevel.X),
      chapter(4, { userId: BLOCKED }),
      chapter(5, { user: { bannedAt: new Date(), deletedAt: null } }),
    ] as never);
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
    const result = await getStorylinesForPosts({
      postIds: [1, 2, 3, 4, 5],
      viewer: { id: STRANGER },
      browsingLevel: NsfwLevel.PG,
    });
    expect(Object.keys(result)).toEqual(['1']);

    // The author of the X post is still told it is a chapter, though it is outside their level.
    // (The fake returns every row whatever the ids, so post 1 comes back too.)
    const asAuthor = await getStorylinesForPosts({
      postIds: [3],
      viewer: { id: AUTHOR_OF_POSTS },
      browsingLevel: NsfwLevel.PG,
    });
    expect(Object.keys(asAuthor)).toEqual(['1', '3']);
    expect(result[1]).toEqual({ chapterId: 1001, depth: 1, storylineId: 10, title: 'A story' });
  });
});

describe('reading', () => {
  const post = (id: number, userId: number, overrides: Record<string, unknown> = {}) => ({
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    user: { username: `u${userId}`, ...notBanned },
    ...overrides,
  });

  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
  });

  describe('getStorylinePath', () => {
    beforeEach(() => {
      // Four chapters: 1 -> 2 (post deleted) -> 3 (taken down) -> 4.
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 3 } as never);
      r.$queryRaw.mockResolvedValue([
        { id: 1, postId: 101, depth: 0 },
        { id: 2, postId: null, depth: 1 },
        { id: 3, postId: 103, depth: 2 },
        { id: 4, postId: 104, depth: 3 },
      ] as never);
      r.post.findMany.mockResolvedValue([
        post(101, OWNER),
        post(103, STRANGER, { tosViolation: true }),
        post(104, COLLABORATOR, { nsfwLevel: NsfwLevel.R }),
      ] as never);
    });

    it('keeps removed chapters as tombstones, with the chapters after them reachable', async () => {
      const { chapters, hasEarlier } = await getStorylinePath({
        chapterId: 4,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
      });

      expect(chapters.map((c) => [c.chapterId, c.tombstone])).toEqual([
        [1, null],
        [2, 'deleted'],
        [3, 'removed'],
        [4, 'browsingLevel'],
      ]);
      expect(hasEarlier).toBe(false);
      // A tombstone carries no post content.
      expect(chapters[2].post).toBeNull();
      expect(chapters[0].post).toMatchObject({ id: 101, username: `u${OWNER}` });
      // The fields the tombstone decides on are asked for.
      expect(r.post.findMany.mock.calls[0][0]).toMatchObject({
        select: { tosViolation: true, user: { select: { bannedAt: true, deletedAt: true } } },
      });
    });

    it("applies the story's ceiling and the reader's blocks to each chapter", async () => {
      // Owned by someone else, so blocking chapter 1's author does not hide the whole story.
      r.storyline.findUnique.mockResolvedValue(
        storylineRow({
          maxNsfwLevel: NsfwLevel.PG,
          userId: 77,
          user: { id: 77, username: 'x', ...notBanned },
        }) as never
      );
      getBlockedPairIds.mockResolvedValue([OWNER]);
      const { chapters } = await getStorylinePath({
        chapterId: 4,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG | NsfwLevel.R,
      });
      expect(chapters.map((c) => c.tombstone)).toEqual([
        'unavailable', // written by a user in a block with the reader
        'deleted',
        'removed',
        'aboveStoryRating',
      ]);
    });

    it('says when the path starts further back than it returned', async () => {
      r.$queryRaw.mockResolvedValue([{ id: 4, postId: 104, depth: 3 }] as never);
      const { hasEarlier } = await getStorylinePath({
        chapterId: 4,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
      });
      expect(hasEarlier).toBe(true);
    });
  });

  describe('a storyline hidden from the reader', () => {
    beforeEach(() => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 0 } as never);
    });

    it.each([
      [
        'taken down',
        () =>
          r.storyline.findUnique.mockResolvedValue(storylineRow({ tosViolation: true }) as never),
      ],
      ['in a block with its owner', () => getBlockedPairIds.mockResolvedValue([OWNER])],
      [
        'owned by a banned user',
        () =>
          r.storyline.findUnique.mockResolvedValue(
            storylineRow({
              user: { id: OWNER, username: 'o', bannedAt: new Date(), deletedAt: null },
            }) as never
          ),
      ],
    ])('when %s, has no path and no children for them', async (_name, arrange) => {
      arrange();
      const read = { chapterId: 1, viewer: { id: STRANGER }, browsingLevel: NsfwLevel.PG };
      await expect(getStorylinePath(read)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(getStorylineChildren(read)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(r.$queryRaw).not.toHaveBeenCalled();
      expect(r.storylineChapterEdge.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getStorylineChildren', () => {
    const edge = (
      chapterId: number,
      userId: number,
      canon: boolean,
      day: number,
      postOverrides: Record<string, unknown> = {}
    ) => ({
      canon,
      chapter: {
        id: chapterId,
        depth: 1,
        userId,
        createdAt: new Date(`2026-10-0${day}`),
        post: post(chapterId + 100, userId, postOverrides),
      },
    });

    beforeEach(() => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
      r.storylineCollaborator.findMany.mockResolvedValue([{ userId: COLLABORATOR }] as never);
    });

    it('orders the ways on: canon, endorsed, then community by readers, keeping tombstones', async () => {
      const all = [
        edge(11, STRANGER, false, 1),
        edge(12, BLOCKED, false, 2, { tosViolation: true }),
        edge(13, COLLABORATOR, false, 3),
        edge(14, OWNER, true, 4),
      ];
      r.storylineChapterEdge.findFirst.mockResolvedValue(all[3] as never);
      r.storylineChapterEdge.findMany.mockImplementation((({
        where,
      }: {
        where: { chapter?: unknown };
      }) => Promise.resolve(where.chapter ? [all[2]] : all)) as never);

      const children = await getStorylineChildren({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
        readersByChapterId: new Map([
          [11, 3],
          [12, 40],
        ]),
      });

      expect(children.map((c) => [c.chapterId, c.rank, c.tombstone])).toEqual([
        [14, 'canon', null],
        [13, 'endorsed', null],
        [12, 'community', 'removed'],
        [11, 'community', null],
      ]);
      // Counts order the list but are not handed to the client.
      expect(children[0]).not.toHaveProperty('readers');
    });

    it('orders community children by stored reader counts when none are passed in', async () => {
      const all = [edge(11, STRANGER, false, 1), edge(12, BLOCKED, false, 2)];
      r.storylineChapterEdge.findFirst.mockResolvedValue(null as never);
      r.storylineChapterEdge.findMany.mockImplementation((({
        where,
      }: {
        where: { chapter?: unknown };
      }) => Promise.resolve(where.chapter ? [] : all)) as never);
      w.storylineBranchChoice.groupBy.mockResolvedValue([
        { chapterId: 12, _count: { _all: 9 } },
        { chapterId: 11, _count: { _all: 2 } },
      ] as never);
      const children = await getStorylineChildren({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
      });
      expect(children.map((c) => c.chapterId)).toEqual([12, 11]);
    });

    it('still lists canon and collaborators first when they fall outside the oldest page', async () => {
      // The oldest-first read is full of strangers; canon and the collaborator are newer.
      const strangers = Array.from({ length: 200 }, (_, i) => edge(1000 + i, STRANGER, false, 1));
      r.storylineChapterEdge.findFirst.mockResolvedValue(edge(14, OWNER, true, 9) as never);
      r.storylineChapterEdge.findMany.mockImplementation((({
        where,
      }: {
        where: { chapter?: { userId: { in: number[] } } };
      }) =>
        Promise.resolve(
          where.chapter?.userId.in.includes(COLLABORATOR)
            ? [edge(13, COLLABORATOR, false, 8)]
            : strangers
        )) as never);

      const children = await getStorylineChildren({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
      });
      expect(children.slice(0, 2).map((c) => c.chapterId)).toEqual([14, 13]);
      expect(children).toHaveLength(200);
      expect(r.storylineChapterEdge.findFirst.mock.calls[0][0]).toMatchObject({
        where: { parentChapterId: 1, canon: true },
      });
    });
  });
});

describe('fork shares', () => {
  const choices = (pairs: Array<[number, number]>) =>
    w.storylineBranchChoice.groupBy.mockResolvedValue(
      pairs.map(([chapterId, n]) => ({ chapterId, _count: { _all: n } })) as never
    );
  const read = { chapterId: 1, viewer: { id: STRANGER }, browsingLevel: NsfwLevel.PG };

  beforeEach(() => {
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
  });

  it('gives no shares below 20 choices by default, with the total so far', async () => {
    choices([
      [11, 12],
      [12, 7],
    ]);
    await expect(getStorylineForkShares(read)).resolves.toEqual({
      enough: false,
      total: 19,
      minChoices: 20,
      shares: {},
    });
    expect(w.storylineBranchChoice.groupBy.mock.calls[0][0]).toMatchObject({
      by: ['chapterId'],
      where: { parentChapterId: 1 },
    });
  });

  it('gives shares at 20 choices', async () => {
    choices([
      [11, 15],
      [12, 5],
    ]);
    await expect(getStorylineForkShares(read)).resolves.toMatchObject({
      enough: true,
      shares: { 11: 0.75, 12: 0.25 },
    });
  });

  it('follows STORYLINE_SHARE_MIN_CHOICES, and ignores an invalid one', async () => {
    choices([[11, 1]]);
    setEnv({ STORYLINE_SHARE_MIN_CHOICES: '1' });
    await expect(getStorylineForkShares(read)).resolves.toMatchObject({
      enough: true,
      minChoices: 1,
      shares: { 11: 1 },
    });
    setEnv({ STORYLINE_SHARE_MIN_CHOICES: '0' });
    await expect(getStorylineForkShares(read)).resolves.toMatchObject({
      enough: false,
      minChoices: 20,
    });
  });

  it('serves nothing for a story the reader cannot open', async () => {
    getBlockedPairIds.mockResolvedValue([OWNER]);
    choices([[11, 50]]);
    await expect(getStorylineForkShares(read)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('recording engagement', () => {
  const reader = { id: STRANGER };
  const PG = NsfwLevel.PG;

  beforeEach(() => {
    // The read gate: chapter 1 of storyline 10, which this reader can see. Looked up on the
    // primary, so a chapter added seconds ago is found.
    w.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
  });

  it("records a reader's latest choice, only for a real way on, and clears the cached counts", async () => {
    w.storylineChapterEdge.findUnique.mockResolvedValue(null as never);
    await expect(
      recordStorylineBranchChoice({
        viewer: reader,
        browsingLevel: PG,
        fromChapterId: 1,
        toChapterId: 99,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(w.storylineBranchChoice.upsert).not.toHaveBeenCalled();
    expect(bustFetchThroughCache).not.toHaveBeenCalled();

    w.storylineChapterEdge.findUnique.mockResolvedValue({ chapterId: 12 } as never);
    await recordStorylineBranchChoice({
      viewer: reader,
      browsingLevel: PG,
      fromChapterId: 1,
      toChapterId: 12,
    });
    expect(w.storylineChapterEdge.findUnique.mock.calls[1][0]).toMatchObject({
      where: { chapterId_parentChapterId: { chapterId: 12, parentChapterId: 1 } },
    });
    expect(w.storylineBranchChoice.upsert.mock.calls[0][0]).toEqual({
      where: { userId_parentChapterId: { userId: STRANGER, parentChapterId: 1 } },
      create: { userId: STRANGER, parentChapterId: 1, chapterId: 12 },
      update: { chapterId: 12 },
    });
    expect(bustFetchThroughCache).toHaveBeenCalledTimes(1);
    expect(bustFetchThroughCache).toHaveBeenCalledWith('packed:caches:storyline-fork-counts:1');
  });

  it('gives no vote to a reader who cannot see the story', async () => {
    getBlockedPairIds.mockResolvedValue([OWNER]);
    w.storylineChapterEdge.findUnique.mockResolvedValue({ chapterId: 12 } as never);
    await expect(
      recordStorylineBranchChoice({
        viewer: reader,
        browsingLevel: PG,
        fromChapterId: 1,
        toChapterId: 12,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      recordStorylineCreateClick({ viewer: reader, browsingLevel: PG, chapterId: 1 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(w.storylineBranchChoice.upsert).not.toHaveBeenCalled();
    expect(w.storylineCreateClick.upsert).not.toHaveBeenCalled();
  });

  it('counts a create click once per reader per chapter', async () => {
    await recordStorylineCreateClick({ viewer: reader, browsingLevel: PG, chapterId: 1 });
    expect(w.storylineCreateClick.upsert.mock.calls[0][0]).toEqual({
      where: { userId_parentChapterId: { userId: STRANGER, parentChapterId: 1 } },
      create: { userId: STRANGER, parentChapterId: 1 },
      update: {},
    });
  });

  it('refuses a create click on a chapter that does not exist', async () => {
    w.storylineChapter.findUnique.mockResolvedValue(null as never);
    await expect(
      recordStorylineCreateClick({ viewer: reader, browsingLevel: PG, chapterId: 404 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(w.storylineCreateClick.upsert).not.toHaveBeenCalled();
  });

  it('keeps the first early-access sign-up and reports it', async () => {
    await joinStorylineEarlyAccess({ userId: STRANGER, storylineId: 10 });
    expect(w.storylineEarlyAccessSignup.upsert.mock.calls[0][0]).toEqual({
      where: { userId: STRANGER },
      create: { userId: STRANGER, storylineId: 10 },
      update: {},
    });
    r.storylineEarlyAccessSignup.findUnique.mockResolvedValue({ userId: STRANGER } as never);
    await expect(getStorylineEarlyAccessStatus(STRANGER)).resolves.toEqual({ joined: true });
    r.storylineEarlyAccessSignup.findUnique.mockResolvedValue(null as never);
    await expect(getStorylineEarlyAccessStatus(STRANGER)).resolves.toEqual({ joined: false });
  });

  it('reports sign-ups, distinct clickers and clicks to moderators', async () => {
    r.storylineEarlyAccessSignup.count.mockResolvedValue(4 as never);
    r.$queryRaw.mockResolvedValue([{ readers: 3, clicks: 7 }] as never);
    await expect(getStorylineEarlyAccessStats()).resolves.toEqual({
      signups: 4,
      createClickReaders: 3,
      createClicks: 7,
    });
  });
});

describe('getStoryline: page fields', () => {
  const user = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    username: `u${id}`,
    image: null,
    profilePicture: null,
    ...notBanned,
    ...extra,
  });

  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue({
      ...storylineRow(),
      collaborators: [{ user: user(COLLABORATOR) }],
    } as never);
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('COUNT(DISTINCT'))
        return Promise.resolve([{ chapters: 4, contributors: 3 }]);
      if (sql.includes('GROUP BY c."userId"'))
        return Promise.resolve([
          { userId: STRANGER },
          { userId: BLOCKED },
          { userId: COLLABORATOR },
        ]);
      if (sql.includes('WITH RECURSIVE main'))
        return Promise.resolve([
          { id: 1, postId: 101, depth: 0 },
          { id: 2, postId: null, depth: 1 },
        ]);
      return Promise.resolve([]);
    }) as never);
    r.user.findMany.mockResolvedValue([user(STRANGER), user(BLOCKED)] as never);
    r.post.findMany.mockResolvedValue([
      {
        id: 101,
        userId: OWNER,
        title: 'one',
        nsfwLevel: NsfwLevel.PG,
        publishedAt: new Date('2026-10-01'),
        tosViolation: false,
        user: { username: 'owner', ...notBanned },
      },
    ] as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([
      { parentChapterId: 1, _count: { _all: 3 } },
    ] as never);
  });

  it('gives counts, roles, the main route with tombstones, and the viewer’s role', async () => {
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
    const page = await getStoryline({
      id: 10,
      viewer: { id: COLLABORATOR },
      browsingLevel: NsfwLevel.PG,
    });
    expect(page).toMatchObject({
      chapterCount: 4,
      contributorCount: 3,
      viewerRole: 'collaborator',
    });
    expect(page.contributors.map((c) => [c.user.id, c.role])).toEqual([
      [OWNER, 'creator'],
      [COLLABORATOR, 'endorsed'],
      // BLOCKED is left out; the collaborator is not listed twice.
      [STRANGER, 'contributor'],
    ]);
    expect(page.mainPath.map((c) => [c.chapterId, c.tombstone, c.childCount])).toEqual([
      [1, null, 3],
      [2, 'deleted', 0],
    ]);
    expect(page.collaborators[0]).not.toHaveProperty('bannedAt');

    // Credited only through chapters this reader is shown.
    const contributorQuery = r.$queryRaw.mock.calls
      .map((call) => {
        const [strings, ...values] = call as unknown as [TemplateStringsArray, ...unknown[]];
        return Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
      })
      .find((sql) => sql.includes('GROUP BY c."userId"'));
    expect(contributorQuery).toMatch(
      /AND\s+p\."tosViolation" = false AND p\."publishedAt" < now\(\)/
    );
    expect(contributorQuery).toContain('& ~');
  });

  it('tells the owner they own it, and a stranger nothing', async () => {
    await expect(
      getStoryline({ id: 10, viewer: { id: OWNER }, browsingLevel: NsfwLevel.PG })
    ).resolves.toMatchObject({ viewerRole: 'owner' });
    await expect(
      getStoryline({ id: 10, viewer: { id: 99 }, browsingLevel: NsfwLevel.PG })
    ).resolves.toMatchObject({ viewerRole: null });
  });
});

describe('getStorylinesInfinite', () => {
  /** The query as Postgres would get it, with the nested fragments composed. */
  const sqlOf = () => {
    const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const composed = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    return { text: composed.sql, values: composed.values };
  };

  it('pages by offset and says when there is more', async () => {
    r.$queryRaw.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: 10 - i,
        title: `s${i}`,
        status: 'Ongoing',
        userId: OWNER,
        username: 'owner',
        rootPostId: 100 + i,
        chapterCount: 1,
        contributorCount: 1,
        createdAt: new Date('2026-10-01'),
      })) as never
    );
    const page = await getStorylinesInfinite({
      filter: 'all',
      sort: 'newest',
      limit: 2,
      viewer: undefined,
      browsingLevel: NsfwLevel.PG,
    });
    expect(page.items.map((s) => s.id)).toEqual([10, 9]);
    // Newest first pages by id: the next page starts below the last id shown.
    expect(page.nextCursor).toBe(9);
    expect(page.items[0].user).toEqual({ id: OWNER, username: 'owner' });
  });

  it('continues newest-first below the last id seen', async () => {
    await getStorylinesInfinite({
      filter: 'all',
      sort: 'newest',
      cursor: 9,
      limit: 20,
      viewer: undefined,
      browsingLevel: NsfwLevel.PG,
    });
    const { text, values } = sqlOf();
    expect(text).toMatch(/st\.id < \?/);
    expect(values).toContain(9);
  });

  it('leaves out owners the reader blocked or hid, and applies the open filter', async () => {
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
    hiddenUsersCached.mockResolvedValue([{ id: 77 }]);
    await getStorylinesInfinite({
      filter: 'open',
      sort: 'mostChapters',
      limit: 20,
      viewer: { id: STRANGER },
      browsingLevel: NsfwLevel.PG,
    });
    const { text, values } = sqlOf();
    expect(text).toContain(`COALESCE(ss.mode, us.mode, 'review') <> 'off'`);
    expect(text).toContain('st."userId" <> ALL(');
    expect(values).toContainEqual(expect.arrayContaining([BLOCKED, 77]));
    // Collaborators-only storylines are open only to their collaborators.
    // Anchored on the opening bracket, so a condition slipped in front of it is caught.
    expect(text).toContain(`(st."whoCanContinue" = 'Anyone' OR st."userId" = `);
    expect(text).toContain('"StorylineCollaborator" sc');
  });
});

describe('updateStoryline: the ceiling cannot drop below chapter 1', () => {
  /**
   * Answers the first-chapter read by what it asks for: this storyline's chapter 1 only for
   * storyline 10 at depth 0. A read of another chapter, or of another storyline, gets an X-rated
   * chapter 3 instead, so a check that asked the wrong question refuses where it should not.
   */
  const chapters = (first: Record<string, unknown> | null, third = { nsfwLevel: NsfwLevel.X }) =>
    w.storylineChapter.findFirst.mockImplementation(((args: {
      where: { storylineId?: number; depth?: number };
    }) =>
      Promise.resolve(
        args.where.storylineId === 10 && args.where.depth === 0
          ? first && { post: first }
          : { post: { tosViolation: false, ...third } }
      )) as never);

  beforeEach(() => {
    w.storyline.findUnique.mockResolvedValue(
      storylineRow({ maxNsfwLevel: NsfwLevel.XXX }) as never
    );
    w.storyline.update.mockResolvedValue(storylineRow() as never);
  });

  const lowerTo = (maxNsfwLevel: number) =>
    updateStoryline({ id: 10, maxNsfwLevel, userId: OWNER });

  it('refuses a ceiling below chapter 1 rating, and writes nothing', async () => {
    chapters({ nsfwLevel: NsfwLevel.R, tosViolation: false });
    await expect(lowerTo(NsfwLevel.PG13)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/first chapter/),
    });
    expect(w.storyline.update).not.toHaveBeenCalled();
  });

  it('judges chapter 1 by its most severe image', async () => {
    chapters({ nsfwLevel: NsfwLevel.PG | NsfwLevel.X, tosViolation: false });
    await expect(lowerTo(NsfwLevel.R)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('accepts a ceiling at chapter 1 rating, and one below a later chapter', async () => {
    // Chapter 1 is PG; chapter 3 is X, and lowering to PG13 hides it, which is allowed.
    chapters({ nsfwLevel: NsfwLevel.PG, tosViolation: false }, { nsfwLevel: NsfwLevel.X });
    await lowerTo(NsfwLevel.PG13);
    chapters({ nsfwLevel: NsfwLevel.R, tosViolation: false });
    await lowerTo(NsfwLevel.R);
    expect(w.storyline.update).toHaveBeenCalledTimes(2);
    expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
      data: { maxNsfwLevel: NsfwLevel.PG13 },
    });
  });

  it.each([
    ['gone', null],
    ['unrated', { nsfwLevel: 0, tosViolation: false }],
    ['taken down', { nsfwLevel: NsfwLevel.XXX, tosViolation: true }],
    ['blocked', { nsfwLevel: NsfwLevel.Blocked, tosViolation: false }],
  ])('accepts any valid ceiling when chapter 1 is %s', async (_name, first) => {
    chapters(first);
    await lowerTo(NsfwLevel.PG);
    expect(w.storyline.update).toHaveBeenCalledTimes(1);
  });

  it('accepts any valid ceiling when chapter 1 post was deleted', async () => {
    w.storylineChapter.findFirst.mockResolvedValue({ post: null } as never);
    await lowerTo(NsfwLevel.PG);
    expect(w.storyline.update).toHaveBeenCalledTimes(1);
  });

  it('lets the ceiling be raised, or kept, even when chapter 1 is rated above it', async () => {
    // Chapter 1 was re-rated XXX after the storyline was made with a ceiling of R.
    w.storyline.findUnique.mockResolvedValue(storylineRow({ maxNsfwLevel: NsfwLevel.R }) as never);
    chapters({ nsfwLevel: NsfwLevel.XXX, tosViolation: false });
    await updateStoryline({ id: 10, maxNsfwLevel: NsfwLevel.X, userId: OWNER });
    await updateStoryline({ id: 10, maxNsfwLevel: NsfwLevel.R, userId: OWNER });
    expect(w.storyline.update).toHaveBeenCalledTimes(2);
  });
});

describe('getStorylineCanonAhead', () => {
  const READER_AUTHOR = 6;
  const post = (id: number, userId: number, overrides: Record<string, unknown> = {}) => ({
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    user: { username: `u${userId}`, ...notBanned },
    ...overrides,
  });

  beforeEach(() => {
    // Ceiling R; chapter 1 PG.
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    // The canon route from chapter 2: 2 -> 3 (taken down) -> 4 -> 5 (R) -> 6 (X) -> 7 (by a user
    // the reader blocked) -> 8 (unpublished, by READER_AUTHOR).
    r.$queryRaw.mockResolvedValue([
      { id: 2, postId: 102, depth: 1 },
      { id: 3, postId: 103, depth: 2 },
      { id: 4, postId: 104, depth: 3 },
      { id: 5, postId: 105, depth: 4 },
      { id: 6, postId: 106, depth: 5 },
      { id: 7, postId: 107, depth: 6 },
      { id: 8, postId: 108, depth: 7 },
    ] as never);
    r.post.findMany.mockResolvedValue([
      post(102, OWNER),
      post(103, OWNER, { tosViolation: true }),
      post(104, OWNER),
      post(105, OWNER, { nsfwLevel: NsfwLevel.R }),
      post(106, OWNER, { nsfwLevel: NsfwLevel.X }),
      post(107, BLOCKED),
      post(108, READER_AUTHOR, { publishedAt: null }),
    ] as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([
      { parentChapterId: 3, _count: { _all: 1 } },
      { parentChapterId: 4, _count: { _all: 3 } },
    ] as never);
    // The reader blocked BLOCKED, who wrote chapter 7; the owner is not in a block with anyone.
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
  });

  const tombstonesFor = async (viewerId: number) =>
    (
      await getStorylineCanonAhead({
        chapterId: 2,
        viewer: { id: viewerId },
        browsingLevel: NsfwLevel.PG | NsfwLevel.PG13,
      })
    ).map((c) => [c.chapterId, c.tombstone]);

  it('returns the canon chapters after the one asked about, each judged for this reader', async () => {
    expect(await tombstonesFor(READER_AUTHOR)).toEqual([
      [3, 'removed'],
      [4, null],
      [5, 'browsingLevel'],
      [6, 'aboveStoryRating'],
      [7, 'unavailable'],
      // Their own unpublished chapter, which only its author is shown.
      [8, null],
    ]);
    expect(getBlockedPairIds).toHaveBeenCalledWith(READER_AUTHOR);
  });

  it('hides an unpublished chapter from everyone but its author', async () => {
    expect((await tombstonesFor(STRANGER)).at(-1)).toEqual([8, 'unavailable']);
  });

  it('counts the ways on from each chapter', async () => {
    const ahead = await getStorylineCanonAhead({
      chapterId: 2,
      viewer: undefined,
      browsingLevel: NsfwLevel.PG,
    });
    expect(ahead.slice(0, 3).map((c) => [c.chapterId, c.childCount])).toEqual([
      [3, 1],
      [4, 3],
      [5, 0],
    ]);
  });

  it('is empty for a chapter with no canon child', async () => {
    r.$queryRaw.mockResolvedValue([{ id: 2, postId: 102, depth: 1 }] as never);
    await expect(
      getStorylineCanonAhead({ chapterId: 2, viewer: undefined, browsingLevel: NsfwLevel.PG })
    ).resolves.toEqual([]);
  });

  it('walks the canon edges from the chapter asked about, at most 199 steps', async () => {
    await getStorylineCanonAhead({ chapterId: 2, viewer: undefined, browsingLevel: NsfwLevel.PG });
    const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toContain('WHERE c.id = ?');
    expect(sql).toContain('e."parentChapterId" = main.id AND e.canon');
    expect(sql).toContain('WHERE main.hops < ?');
    expect(sql).toContain('ORDER BY depth');
    expect(values).toEqual([2, 199]);
  });

  it('serves nothing when the story is outside the reader level', async () => {
    r.storyline.findUnique.mockResolvedValue(
      storylineRow({
        chapters: [{ id: 1, postId: 101, post: { nsfwLevel: NsfwLevel.X } }],
      }) as never
    );
    await expect(
      getStorylineCanonAhead({
        chapterId: 2,
        viewer: { id: STRANGER },
        browsingLevel: NsfwLevel.PG,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(r.$queryRaw).not.toHaveBeenCalled();
  });

  it('serves nothing when the storyline is hidden from the reader', async () => {
    getBlockedPairIds.mockResolvedValue([OWNER]);
    await expect(
      getStorylineCanonAhead({ chapterId: 2, viewer: { id: BLOCKED }, browsingLevel: NsfwLevel.PG })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(r.$queryRaw).not.toHaveBeenCalled();
  });

  it('is not found for a chapter that does not exist', async () => {
    r.storylineChapter.findUnique.mockResolvedValue(null as never);
    await expect(
      getStorylineCanonAhead({ chapterId: 99, viewer: undefined, browsingLevel: NsfwLevel.PG })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('getStorylineChapterLevels', () => {
  const HIDDEN = 11;
  const row = (depth: number, nsfwLevel: number, overrides: Record<string, unknown> = {}) => ({
    depth,
    userId: STRANGER,
    nsfwLevel,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    bannedAt: null,
    deletedAt: null,
    ...overrides,
  });

  beforeEach(() => {
    w.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    r.$queryRaw.mockResolvedValue([
      row(0, NsfwLevel.PG13, { userId: OWNER }),
      row(1, NsfwLevel.R),
      row(2, NsfwLevel.X),
      row(2, NsfwLevel.PG, { userId: OWNER }),
    ] as never);
  });

  it('gives the owner chapter 1 level apart from the later chapters', async () => {
    await expect(getStorylineChapterLevels({ id: 10, userId: OWNER })).resolves.toEqual({
      rootNsfwLevel: NsfwLevel.PG13,
      chapterLevels: [NsfwLevel.R, NsfwLevel.X, NsfwLevel.PG],
    });
  });

  it('reads this storyline chapters in depth order, in one query', async () => {
    await getStorylineChapterLevels({ id: 10, userId: OWNER });
    expect(r.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toContain('WHERE c."storylineId" = ?\n');
    expect(sql).toContain('ORDER BY c.depth, c.id');
    expect(values).toEqual([10]);
  });

  it('leaves out every later chapter the owner is shown as a tombstone', async () => {
    getBlockedPairIds.mockResolvedValue([BLOCKED]);
    hiddenUsersCached.mockResolvedValue([{ id: HIDDEN }]);
    r.$queryRaw.mockResolvedValue([
      row(0, NsfwLevel.PG, { userId: OWNER }),
      row(1, NsfwLevel.R),
      row(1, NsfwLevel.X, { tosViolation: true }),
      row(1, NsfwLevel.X, { publishedAt: null }),
      row(1, NsfwLevel.X, { bannedAt: new Date('2026-10-02') }),
      row(1, NsfwLevel.X, { deletedAt: new Date('2026-10-02') }),
      row(1, NsfwLevel.X, { userId: BLOCKED }),
      row(1, NsfwLevel.X, { userId: HIDDEN }),
      row(1, NsfwLevel.Blocked),
      row(1, 0),
    ] as never);
    await expect(getStorylineChapterLevels({ id: 10, userId: OWNER })).resolves.toEqual({
      rootNsfwLevel: NsfwLevel.PG,
      chapterLevels: [NsfwLevel.R],
    });
    expect(getBlockedPairIds).toHaveBeenCalledWith(OWNER);
    expect(hiddenUsersCached).toHaveBeenCalledWith({ userId: OWNER });
  });

  it('counts the owner own unpublished chapter, which the owner is shown', async () => {
    r.$queryRaw.mockResolvedValue([
      row(0, NsfwLevel.PG, { userId: OWNER }),
      row(1, NsfwLevel.X, { userId: OWNER, publishedAt: null }),
    ] as never);
    await expect(getStorylineChapterLevels({ id: 10, userId: OWNER })).resolves.toMatchObject({
      chapterLevels: [NsfwLevel.X],
    });
  });

  it.each([
    ['gone', []],
    ['unrated', [row(0, 0, { userId: OWNER })]],
    ['taken down', [row(0, NsfwLevel.R, { userId: OWNER, tosViolation: true })]],
    ['blocked', [row(0, NsfwLevel.Blocked, { userId: OWNER })]],
  ])('has no chapter 1 level when chapter 1 is %s, as the floor does', async (_name, rows) => {
    r.$queryRaw.mockResolvedValue(rows as never);
    await expect(getStorylineChapterLevels({ id: 10, userId: OWNER })).resolves.toMatchObject({
      rootNsfwLevel: null,
    });
  });

  it('answers a moderator as the owner sees the story', async () => {
    await getStorylineChapterLevels({ id: 10, userId: MODERATOR, isModerator: true });
    expect(getBlockedPairIds).toHaveBeenCalledWith(OWNER);
  });

  it('refuses everyone but the owner and moderators', async () => {
    for (const userId of [COLLABORATOR, STRANGER])
      await expect(getStorylineChapterLevels({ id: 10, userId })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    expect(r.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('getStorylinesInfinite: card cover, open and continue price', () => {
  const feedRow = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `s${id}`,
    status: 'Ongoing',
    userId: 1000 + id,
    username: `u${id}`,
    bannedAt: null,
    deletedAt: null,
    maxNsfwLevel: NsfwLevel.R,
    whoCanContinue: 'Anyone',
    isCollaborator: false,
    rootPostId: 500 + id,
    rootNsfwLevel: NsfwLevel.PG,
    rootPublishedAt: new Date('2026-10-01'),
    rootTosViolation: false,
    storylineMode: null,
    storylinePrice: null,
    userMode: null,
    userPrice: null,
    chapterCount: 1,
    contributorCount: 1,
    createdAt: new Date('2026-10-01'),
    ...overrides,
  });
  const cover = (postId: number) => ({
    postId,
    id: 9000 + postId,
    url: `u-${postId}`,
    type: 'image',
    nsfwLevel: NsfwLevel.PG,
    hash: null,
    width: 512,
    height: 512,
    userId: 1,
    minor: false,
    poi: false,
  });

  /** Answers the page read with `rows` and the cover read with a cover for each post asked. */
  const answer = (rows: ReturnType<typeof feedRow>[]) =>
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('DISTINCT ON (i."postId")')) {
        const postIds = values[0] as number[];
        return Promise.resolve(postIds.map(cover));
      }
      return Promise.resolve(rows);
    }) as never);

  const caps = (max: number) =>
    placementPriceRanges.mockImplementation(((ids: number[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, { max }])))) as never);

  /** The nth raw query as Postgres gets it, whitespace collapsed. */
  const sqlAt = (n: number) => {
    const [strings, ...values] = r.$queryRaw.mock.calls[n] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const composed = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    return { text: composed.sql.replace(/\s+/g, ' '), values: composed.values };
  };

  const feed = (viewer?: { id: number }) =>
    getStorylinesInfinite({
      filter: 'all',
      sort: 'newest',
      limit: 24,
      viewer,
      browsingLevel: NsfwLevel.PG,
    });

  beforeEach(() => {
    caps(100);
  });

  it('reads a 24-card page in two queries and one batched price read, whoever owns it', async () => {
    // 25 rows: a full page plus the one that says there is more, every card a different owner.
    answer(Array.from({ length: 25 }, (_, i) => feedRow(100 - i)));
    const page = await feed({ id: STRANGER });
    expect(page.items).toHaveLength(24);
    // The page and the covers. Neither grows with the cards.
    expect(r.$queryRaw).toHaveBeenCalledTimes(2);
    expect(placementPriceRanges).toHaveBeenCalledTimes(1);
    expect(placementPriceRanges.mock.calls[0][0]).toHaveLength(24);
    expect(placementPriceRanges.mock.calls[0][1]).toBe('storyline');
    expect(r.storylineCollaborator.findMany).not.toHaveBeenCalled();
    expect(r.image.findMany).not.toHaveBeenCalled();
    expect(page.items.every((item) => item.coverImage?.id === 9000 + (item.rootPostId ?? 0))).toBe(
      true
    );
  });

  it('asks for covers from chapter 1 posts only, at the reader level, the ceiling, minus hidden', async () => {
    getAllHiddenForUser.mockResolvedValue({
      hiddenImages: [{ id: 77 }, { id: 78 }],
      hiddenTags: [{ id: 5 }, { id: 6 }],
    });
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const [strings, ...values] = r.$queryRaw.mock.calls[1] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toContain('JOIN "StorylineChapter" c ON c."postId" = i."postId" AND c.depth = 0');
    expect(sql).toContain(
      `i.ingestion = 'Scanned' AND i."tosViolation" = false AND i."needsReview" IS NULL`
    );
    expect(sql).toContain('AND (i."nsfwLevel" & ?::int) <> 0');
    expect(sql).toContain('AND (i."nsfwLevel" & ~(st."maxNsfwLevel" * 2 - 1)) = 0');
    expect(sql).toContain('AND i.id <> ALL(?::int[])');
    // Whitespace-insensitive, anchored on the NOT EXISTS so a negation dropped in front is caught.
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'AND (NOT EXISTS ( SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."tagId" = ANY(?::int[]) AND toi.disabled = false ) OR i."userId" = ?)'
    );
    expect(sql).toContain('ORDER BY i."postId", i.index NULLS LAST, i.id');
    expect(values).toEqual([[501], STRANGER, NsfwLevel.PG, [77, 78], [5, 6], STRANGER]);
    expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: STRANGER });
  });

  it('gives no cover from a chapter 1 the reader is shown as a tombstone, and does not read one', async () => {
    answer([
      feedRow(1, { rootTosViolation: true }),
      feedRow(2, { rootPublishedAt: null }),
      feedRow(3, { rootNsfwLevel: 0 }),
      feedRow(4, { rootPostId: null }),
    ]);
    const page = await feed({ id: STRANGER });
    expect(page.items.map((item) => item.coverImage)).toEqual([null, null, null, null]);
    expect(r.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('applies the site defaults for a signed-out reader', async () => {
    answer([feedRow(1)]);
    await feed(undefined);
    expect(getAllHiddenForUser).toHaveBeenCalledWith({});
  });

  it.each([
    ['open by default', {}, true],
    ['a Complete storyline', { status: 'Complete' }, false],
    ['closed on the storyline', { storylineMode: 'off' }, false],
    ['closed on the account, nothing on the storyline', { userMode: 'off' }, false],
    [
      'open on the storyline over a closed account',
      { storylineMode: 'review', userMode: 'off' },
      true,
    ],
    ['collaborators only, the reader not one', { whoCanContinue: 'Collaborators' }, false],
    [
      'collaborators only, the reader one',
      { whoCanContinue: 'Collaborators', isCollaborator: true },
      true,
    ],
    [
      'collaborators only, the reader the owner',
      { whoCanContinue: 'Collaborators', userId: STRANGER },
      true,
    ],
  ])('open: %s', async (_name, overrides, open) => {
    answer([feedRow(1, overrides)]);
    const [item] = (await feed({ id: STRANGER })).items;
    expect(item.open).toBe(open);
  });

  it('asks Postgres whether this reader collaborates, by their id', async () => {
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const composed = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    expect(composed.sql).toContain('WHERE vc."storylineId" = st.id AND vc."userId" = ?');
    expect(composed.values).toContain(STRANGER);
  });

  it.each([
    ['the storyline price, under the cap', { storylinePrice: 40 }, 100, 40],
    ['the storyline price, held to the cap', { storylinePrice: 400 }, 100, 100],
    [
      'the account price when the storyline sets none',
      { userMode: 'review', userPrice: 30 },
      100,
      30,
    ],
    [
      'the storyline price over the account price',
      { storylineMode: 'review', storylinePrice: 20, userMode: 'review', userPrice: 30 },
      100,
      20,
    ],
    ['free when nothing is priced', {}, 100, 0],
  ])('continuePrice: %s', async (_name, overrides, cap, price) => {
    caps(cap);
    answer([
      feedRow(1, {
        storylineMode: 'storylinePrice' in overrides ? 'review' : null,
        ...overrides,
      }),
    ]);
    const [item] = (await feed({ id: STRANGER })).items;
    expect(item.continuePrice).toBe(price);
  });

  it('keeps internal columns off the card', async () => {
    answer([feedRow(1)]);
    const [item] = (await feed({ id: STRANGER })).items;
    for (const key of [
      'bannedAt',
      'deletedAt',
      'isCollaborator',
      'rootNsfwLevel',
      'rootPublishedAt',
      'rootTosViolation',
      'storylineMode',
      'storylinePrice',
      'userMode',
      'userPrice',
    ])
      expect(item).not.toHaveProperty(key);
  });

  it('gives no cover when chapter 1 is above the story rating, even inside the reader level', async () => {
    answer([feedRow(1, { rootNsfwLevel: NsfwLevel.X })]);
    const page = await getStorylinesInfinite({
      filter: 'all',
      sort: 'newest',
      limit: 24,
      viewer: { id: STRANGER },
      browsingLevel: NsfwLevel.PG | NsfwLevel.R | NsfwLevel.X,
    });
    expect(page.items[0].coverImage).toBeNull();
    expect(r.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('never covers with a minor, real-person or someone else private image', async () => {
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const { text, values } = sqlAt(1);
    expect(text).toContain('JOIN "Post" p ON p.id = i."postId"');
    expect(text).toContain('AND i.minor = false AND i.poi = false');
    expect(text).toContain(`AND (p.availability <> 'Private' OR p."userId" = ?)`);
    expect(values.filter((v) => v === STRANGER)).toHaveLength(2);
  });

  it('adds the browsing-settings tag exclusions for the reader level to the hidden tags', async () => {
    enforceBlockedBrowsingTags.mockImplementation((async (input: { excludedTagIds?: number[] }) => {
      input.excludedTagIds = [6, 9];
      return { emptyResult: false };
    }) as never);
    getAllHiddenForUser.mockResolvedValue({ hiddenImages: [], hiddenTags: [{ id: 5 }, { id: 6 }] });
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    expect(enforceBlockedBrowsingTags).toHaveBeenCalledWith(
      expect.objectContaining({ browsingLevel: NsfwLevel.PG }),
      expect.objectContaining({ id: STRANGER })
    );
    expect(sqlAt(1).values).toContainEqual([5, 6, 9]);
  });

  // Decision, for whoever edits this next: the input handed to enforceBlockedBrowsingTags carries
  // NO userId. With one, its own-scope rule treats every reader as browsing their own images and
  // drops all the site's browsing-settings tag exclusions from every cover.
  it('asks for the browsing-settings exclusions as a mixed feed, never as the reader own images', async () => {
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const [input] = enforceBlockedBrowsingTags.mock.calls[0] as unknown as [
      Record<string, unknown>
    ];
    expect(input).not.toHaveProperty('userId');
    expect(input).not.toHaveProperty('username');
  });

  it('shows no price, rather than failing the page, when owner caps cannot be read', async () => {
    placementPriceRanges.mockRejectedValue(new Error('cap read failed'));
    answer([feedRow(1, { storylineMode: 'review', storylinePrice: 40 }), feedRow(2)]);
    const page = await feed({ id: STRANGER });
    expect(page.items.map((item) => item.continuePrice)).toEqual([null, null]);
    expect(page.items[0].coverImage?.id).toBe(9501);
  });

  it('prices each card at its own owner cap, and an owner with no cap as unknown', async () => {
    answer([
      feedRow(1, { storylineMode: 'review', storylinePrice: 400 }),
      feedRow(2, { storylineMode: 'review', storylinePrice: 400 }),
      feedRow(3, { storylineMode: 'review', storylinePrice: 400 }),
    ]);
    placementPriceRanges.mockResolvedValue(
      new Map([
        [1001, { max: 50 }],
        [1002, { max: 250 }],
      ])
    );
    const page = await feed({ id: STRANGER });
    expect(page.items.map((item) => item.continuePrice)).toEqual([50, 250, null]);
  });

  it('joins each card to its own storyline space and its owner account space', async () => {
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const { text } = sqlAt(0);
    expect(text).toContain(
      `LEFT JOIN "PlacementSpace" ss ON ss.surface = 'storyline' AND ss."entityType" = 'storyline' AND ss."entityId" = st.id`
    );
    expect(text).toContain(
      `LEFT JOIN "PlacementSpace" us ON us.surface = 'storyline' AND us."entityType" = 'user' AND us."entityId" = st."userId"`
    );
    expect(text).toContain(
      'ss.mode AS "storylineMode", ss.price AS "storylinePrice", us.mode AS "userMode", us.price AS "userPrice"'
    );
    expect(text).toContain(
      'rc."postId" AS "rootPostId", rp."nsfwLevel" AS "rootNsfwLevel", rp."publishedAt" AS "rootPublishedAt", rp."tosViolation" AS "rootTosViolation"'
    );
    expect(text).toContain('u."bannedAt", u."deletedAt"');
  });

  it('reads covers by post, from the storyline that post opens, with every column a card renders', async () => {
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const { text } = sqlAt(1);
    expect(text).toContain(
      'SELECT DISTINCT ON (i."postId") i."postId", i.id, i.url, i.type, i."nsfwLevel", i.hash, i.width, i.height, i."userId", i.minor, i.poi FROM "Image" i'
    );
    expect(text).toContain('JOIN "Storyline" st ON st.id = c."storylineId"');
    expect(text).toContain('WHERE i."postId" = ANY(');
    expect(text).toContain('AND i."acceptableMinor" = false');
    // The reader's own image is exempt from their hidden tags, as in image reads.
    expect(text).toContain('AND toi.disabled = false ) OR i."userId" = ');
  });

  it('returns the cover as read, keyed by its post', async () => {
    answer([feedRow(1)]);
    const [item] = (await feed({ id: STRANGER })).items;
    const { postId: _postId, ...expected } = cover(501);
    expect(item.coverImage).toEqual(expected);
  });

  it.each([
    ['the owner is banned', { bannedAt: new Date('2026-10-02') }],
    ['the owner is deleted', { deletedAt: new Date('2026-10-02') }],
    ['chapter 1 is outside the reader level', { rootNsfwLevel: NsfwLevel.PG13 }],
  ])('gives no cover when %s', async (_name, overrides) => {
    answer([feedRow(1, overrides)]);
    const [item] = (await feed({ id: STRANGER })).items;
    expect(item.coverImage).toBeNull();
    expect(r.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('gives no cover from an owner the reader is in a block with', async () => {
    getBlockedPairIds.mockResolvedValue([1001]);
    answer([feedRow(1)]);
    const [item] = (await feed({ id: STRANGER })).items;
    expect(item.coverImage).toBeNull();
  });

  it('gives the owner a cover from their own unpublished chapter 1', async () => {
    answer([feedRow(1, { rootPublishedAt: null })]);
    const [item] = (await feed({ id: 1001 })).items;
    expect(item.coverImage?.id).toBe(9501);
  });

  it('is not open to a signed-out reader on a collaborators-only storyline', async () => {
    answer([feedRow(1, { whoCanContinue: 'Collaborators' })]);
    const [item] = (await feed(undefined)).items;
    expect(item.open).toBe(false);
  });

  it('leaves Complete storylines out of the open filter', async () => {
    answer([]);
    await getStorylinesInfinite({
      filter: 'open',
      sort: 'newest',
      limit: 24,
      viewer: { id: STRANGER },
      browsingLevel: NsfwLevel.PG,
    });
    expect(sqlAt(0).text).toContain(`st.status <> 'Complete'`);
  });
});

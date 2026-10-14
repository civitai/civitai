import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';

const getBlockedPairIds = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferencesService>()),
  getBlockedPairIds,
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
  getStorylineChildren,
  getStorylinePath,
  getStorylinesForPosts,
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
  maxNsfwLevel: NsfwLevel.R,
  tosViolation: false,
  createdAt: new Date('2026-10-01'),
  user: { id: OWNER, username: 'owner', ...notBanned },
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
    storyline: { userId: OWNER, maxNsfwLevel: NsfwLevel.R, tosViolation: false },
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
      /taken down/,
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
    post: { nsfwLevel: level },
    storyline: {
      id: 10,
      title: 'A story',
      userId: OWNER,
      tosViolation: false,
      user: notBanned,
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

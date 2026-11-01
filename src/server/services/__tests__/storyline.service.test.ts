import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CoverImageService from '~/server/services/cover-image.service';
import { Prisma } from '@prisma/client';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as PlacementService from '~/server/services/placement.service';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';
import type * as UserPreferencesService from '~/server/services/user-preferences.service';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { dbMock, resetSharedMocks, setEnv } from '~/__tests__/mocks';
import { NsfwLevel } from '~/server/common/enums';
import { raiseNsfwLevelText } from '@civitai/shared/rated-entity-sql';
import type * as NotificationService from '~/server/services/notification.service';
import { storylineTextScanSubject } from '~/server/services/text-scan/profiles/storyline.profile';
import { textScanTextHash } from '~/server/services/text-scan/prompt';
import { STORYLINE_GRAPH_LIMIT } from '~/shared/utils/storyline';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import type { StorylineRootHiddenReason } from '~/shared/utils/storyline';

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
  // Straight through to the origin.
  fetchThroughCache: (_key: string, fn: () => Promise<unknown>) => fn(),
  setFetchThroughCache,
}));
const setFetchThroughCache = vi.hoisted(() => vi.fn());
const resolveCoverImageId = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/cover-image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverImageService>()),
  resolveCoverImageId,
}));
const UPLOAD_URL = '00000000-0000-4000-8000-000000000001';
const createNotification = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));
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
const { scanEntityInBackground } = vi.hoisted(() => ({ scanEntityInBackground: vi.fn() }));
const { trackModActivity } = vi.hoisted(() => ({ trackModActivity: vi.fn() }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntityInBackground,
}));

import {
  addOwnerChapter,
  addStorylineCollaborator,
  createStoryline,
  getStoryline,
  assertCanContinueStoryline,
  getStorylineCanonAhead,
  getStorylineChapterLevels,
  getStorylineChildren,
  getStorylinePath,
  getStorylineForkShares,
  getStorylineGraph,
  getStorylinesForPosts,
  getStorylineEarlyAccessStats,
  getStorylineEarlyAccessStatus,
  getStorylinesInfinite,
  getPendingChapterForPost,
  joinStorylineEarlyAccess,
  linkPendingChapter,
  moderateStorylineTitle,
  recordStorylineBranchChoice,
  recordStorylineCreateClick,
  removePendingChapter,
  removeStorylineCollaborator,
  acceptStorylineInvite,
  assertCanContinueStoryline,
  assertStorylineVisible,
  setCanonChapter,
  updateStoryline,
  writeChapterEdgeForPlacement,
} from '~/server/services/storyline.service';
import { COVER_IMAGE_UNAVAILABLE_MESSAGE } from '~/server/services/cover-image.service';

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
/** Chapter 1 as a public storyline has it: published, rated and not taken down. */
const shownRootChapters = [
  {
    id: 1,
    postId: 101,
    removedAt: null,
    post: {
      nsfwLevel: NsfwLevel.PG,
      publishedAt: new Date(0),
      tosViolation: false,
      user: notBanned,
    },
  },
];

const storylineRow = (overrides: Record<string, unknown> = {}) => ({
  id: 10,
  userId: OWNER,
  title: 'A story',
  status: 'Ongoing',
  whoCanContinue: 'Anyone',
  maxNsfwLevel: NsfwLevel.R,
  tosViolation: false,
  nsfwLevel: 0,
  moderatorNsfwLevel: null,
  createdAt: new Date('2026-10-01'),
  user: { id: OWNER, username: 'owner', ...notBanned },
  // Chapter 1, PG: inside every reader level used here unless a test says otherwise.
  chapters: [
    {
      id: 1,
      postId: 101,
      removedAt: null,
      post: {
        nsfwLevel: NsfwLevel.PG,
        publishedAt: new Date(0),
        tosViolation: false,
        user: { bannedAt: null, deletedAt: null },
      },
    },
  ],
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
/** The SQL a raw call sends, with nested fragments (the main-route walk) composed in. */
const sqlOfRaw = (strings: TemplateStringsArray, values: unknown[]) =>
  Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
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
  setFetchThroughCache.mockReset();
  scanEntityInBackground.mockReset();
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
      chapters: shownRootChapters,
    },
  };

  // By its post, as the approval finds it, and by its id, as the add re-reads it under its locks.
  const findChapter = (parent: { id: number }) =>
    (({ where }: { where: { id?: number; placementId?: number; postId?: number } }) =>
      Promise.resolve(
        where.postId === args.parentPostId || where.id === parent.id ? parent : null
      )) as never;

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
      data: { storylineId: 10, chapterId: 30, parentChapterId: 20, canon: true },
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

  // Not only the owner's: an approved continuation takes the empty slot too.
  it.each([
    ['the owner', OWNER],
    ['a contributor', STRANGER],
  ])(
    "marks %s's continuation canon only when the parent has no canon child",
    async (_who, placerId) => {
      let canonTaken = false;
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: placerId }) as never);
      w.storylineChapterEdge.findFirst.mockImplementation((({
        where,
      }: {
        where: { parentChapterId: number; canon: boolean };
      }) =>
        Promise.resolve(
          where.parentChapterId === 20 && where.canon && canonTaken ? { chapterId: 21 } : null
        )) as never);

      await writeChapterEdgeForPlacement({ ...args, placerId }, tx);
      expect(w.storylineChapterEdge.create.mock.calls[0][0]).toMatchObject({
        data: { canon: true },
      });

      canonTaken = true;
      await writeChapterEdgeForPlacement({ ...args, placerId }, tx);
      expect(w.storylineChapterEdge.create.mock.calls[1][0]).toMatchObject({
        data: { canon: false },
      });
    }
  );

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
      /can't be used in a storyline/,
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

  // Whether a continuation skips the owner's review follows `isCollaborator`.
  it('does not count an invitee who has not accepted as a collaborator', async () => {
    w.storylineChapter.findUnique.mockResolvedValue({ ...parentChapter, removedAt: null } as never);
    w.storylineCollaborator.findUnique.mockResolvedValue({ acceptedAt: null } as never);
    await expect(
      assertCanContinueStoryline({ parentPostId: 500, placerId: STRANGER })
    ).resolves.toMatchObject({ isCollaborator: false });
    w.storylineCollaborator.findUnique.mockResolvedValue({ acceptedAt: new Date() } as never);
    await expect(
      assertCanContinueStoryline({ parentPostId: 500, placerId: STRANGER })
    ).resolves.toMatchObject({ isCollaborator: true });
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

    it('refuses an invitee who has not accepted', async () => {
      w.storylineCollaborator.findUnique.mockResolvedValue({ acceptedAt: null } as never);
      await expect(writeChapterEdgeForPlacement(args, tx)).rejects.toMatchObject({
        message: 'storyline: only collaborators on this storyline can continue it',
      });
      expect(w.storylineChapter.create).not.toHaveBeenCalled();
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
            ? { acceptedAt: new Date() }
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
    // The parent-author block check, the storyline's shared lock, and the parent lock, taken
    // again for the canon slot (the owner placing on their own storyline skips the owner check).
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
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

  it('starts an empty storyline when no post is given, and scans its title', async () => {
    await expect(
      createStoryline({ title: 't', maxNsfwLevel: NsfwLevel.R, userId: OWNER })
    ).resolves.toEqual({ id: 10, rootChapterId: null });
    expect(w.storyline.create.mock.calls[0][0]).toMatchObject({
      data: { userId: OWNER, title: 't', maxNsfwLevel: NsfwLevel.R },
    });
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(scanEntityInBackground).toHaveBeenCalledWith({ entityType: 'Storyline', entityId: 10 });
  });

  it('refuses a cover pick on a storyline with no chapters to pick from', async () => {
    w.image.findMany.mockResolvedValue([
      {
        id: 77,
        nsfwLevel: NsfwLevel.PG,
        minor: false,
        poi: false,
        post: { storylineChapter: null },
      },
    ] as never);
    await expect(
      createStoryline({ title: 't', maxNsfwLevel: NsfwLevel.R, coverImageId: 77, userId: OWNER })
    ).rejects.toThrow(/your own chapters/);
    expect(w.storyline.update).not.toHaveBeenCalled();
  });
});

describe('linkPendingChapter', () => {
  const POST = 900;
  const link = (input: { storylineId?: number; parentChapterId?: number }, userId = OWNER) =>
    linkPendingChapter(tx, { postId: POST, userId, ...input });
  /** Chapter 30 of storyline 10, whose post is 300: found by its id and by its post id. */
  const parentChapter = (storyline: Record<string, unknown> = {}) =>
    w.storylineChapter.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id?: number; postId?: number };
    }) =>
      where.id === 30 || where.postId === 300
        ? {
            id: 30,
            storylineId: 10,
            postId: 300,
            depth: 2,
            userId: PARENT_AUTHOR,
            removedAt: null,
            storyline: {
              userId: OWNER,
              maxNsfwLevel: NsfwLevel.R,
              minorByScan: false,
              tosViolation: false,
              whoCanContinue: 'Anyone',
              chapters: shownRootChapters,
              ...storyline,
            },
          }
        : null) as never);

  describe('starting chapter 1', () => {
    const owned = (overrides: Record<string, unknown> = {}) =>
      w.storyline.findUnique.mockResolvedValue({
        userId: OWNER,
        tosViolation: false,
        chapters: [],
        ...overrides,
      } as never);

    it("links the owner's draft as chapter 1", async () => {
      owned();
      await link({ storylineId: 10 });
      expect(w.storylinePendingChapter.create).toHaveBeenCalledWith({
        data: { postId: POST, storylineId: 10, parentChapterId: null, userId: OWNER },
      });
    });

    it.each([
      ["someone else's storyline", {}, STRANGER, /creator/],
      ['a taken-down storyline', { tosViolation: true }, OWNER, /taken down/],
      ['a storyline that has its chapter 1', { chapters: [{ id: 1 }] }, OWNER, /first chapter/],
    ])('refuses %s', async (_name, overrides, userId, message) => {
      owned(overrides);
      await expect(link({ storylineId: 10 }, userId)).rejects.toThrow(message);
      expect(w.storylinePendingChapter.create).not.toHaveBeenCalled();
    });

    it('refuses a second chapter-1 draft as a 400, not a 500', async () => {
      owned();
      w.storylinePendingChapter.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }) as never
      );
      await expect(link({ storylineId: 10 })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This storyline already has a draft of its first chapter',
      });
    });
  });

  describe('continuing a chapter', () => {
    it("links the draft under the parent, in the parent's storyline", async () => {
      parentChapter();
      await link({ parentChapterId: 30 }, STRANGER);
      expect(w.storylinePendingChapter.create).toHaveBeenCalledWith({
        data: { postId: POST, storylineId: 10, parentChapterId: 30, userId: STRANGER },
      });
    });

    it('holds a continuation to the same rule as submitting one', async () => {
      parentChapter({ whoCanContinue: 'Collaborators' });
      await expect(link({ parentChapterId: 30 }, STRANGER)).rejects.toThrow(
        'storyline: only collaborators on this storyline can continue it'
      );
      blockedPairs = [[OWNER, STRANGER]];
      parentChapter();
      await expect(link({ parentChapterId: 30 }, STRANGER)).rejects.toThrow(
        'Continuations are not available on this chapter'
      );
      expect(w.storylinePendingChapter.create).not.toHaveBeenCalled();
    });

    it('refuses a chapter of another storyline than the one named', async () => {
      parentChapter();
      await expect(link({ storylineId: 11, parentChapterId: 30 })).rejects.toThrow(
        'That chapter is not in this storyline'
      );
      expect(w.storylinePendingChapter.create).not.toHaveBeenCalled();
    });

    it('refuses a chapter that does not exist', async () => {
      parentChapter();
      await expect(link({ parentChapterId: 31 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.storylinePendingChapter.create).not.toHaveBeenCalled();
    });
  });
});

describe('getPendingChapterForPost', () => {
  beforeEach(() => {
    w.storylinePendingChapter.findUnique.mockResolvedValue({
      postId: 900,
      userId: STRANGER,
      parentChapterId: 30,
      storyline: { ...storylineRow(), minorByScan: true },
      parentChapter: { id: 30, depth: 2, postId: 300 },
    } as never);
  });

  it("gives the draft's author the storyline it was started from", async () => {
    const pending = await getPendingChapterForPost({ postId: 900, userId: STRANGER });
    expect(pending).toMatchObject({
      postId: 900,
      storyline: { id: 10, title: 'A story', takenDown: false },
      parentChapter: { id: 30, depth: 2, postId: 300 },
    });
    // The ceiling the chapter is held to, never the scan's minor finding itself.
    expect(pending?.storyline.maxNsfwLevel).toBe(NsfwLevel.PG13);
    expect(pending?.storyline).not.toHaveProperty('minorByScan');
  });

  it('is null for anyone else, and for a post with no link', async () => {
    await expect(getPendingChapterForPost({ postId: 900, userId: OWNER })).resolves.toBeNull();
    await expect(
      getPendingChapterForPost({ postId: 900, userId: MODERATOR, isModerator: true })
    ).resolves.not.toBeNull();
    w.storylinePendingChapter.findUnique.mockResolvedValue(null as never);
    await expect(getPendingChapterForPost({ postId: 900, userId: STRANGER })).resolves.toBeNull();
  });
});

describe('removePendingChapter', () => {
  type DeleteWhere = {
    postId?: number;
    userId?: number;
    post?: { userId?: number; publishedAt?: Date | null };
  };
  const link = (overrides: { userId?: number; publishedAt?: Date | null } = {}) => ({
    userId: overrides.userId ?? STRANGER,
    post: { userId: STRANGER, publishedAt: overrides.publishedAt ?? null },
  });
  /** Rows the conditional delete would match, so a missing condition deletes what it must not. */
  const deletes = (row: ReturnType<typeof link>) =>
    w.storylinePendingChapter.deleteMany.mockImplementation((({ where }: { where: DeleteWhere }) =>
      Promise.resolve({
        count:
          where.postId === 900 &&
          where.userId === row.userId &&
          where.post?.userId === row.post.userId &&
          where.post?.publishedAt === null &&
          row.post.publishedAt === null
            ? 1
            : 0,
      })) as never);

  it("unlinks the author's unpublished draft, touching nothing else", async () => {
    w.storylinePendingChapter.findUnique.mockResolvedValue(link() as never);
    deletes(link());
    await expect(removePendingChapter({ postId: 900, userId: STRANGER })).resolves.toEqual({
      removed: true,
    });
    expect(w.storylinePendingChapter.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: 900 } })
    );
    expect(r.storylinePendingChapter.findUnique).not.toHaveBeenCalled();
    expect(w.storylinePendingChapter.deleteMany).toHaveBeenCalledTimes(1);
    expect(w.storylinePendingChapter.delete).not.toHaveBeenCalled();
    expect(w.post.update).not.toHaveBeenCalled();
    expect(w.post.updateMany).not.toHaveBeenCalled();
    expect(w.post.delete).not.toHaveBeenCalled();
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
  });

  it("refuses anyone but the draft's author, moderators included", async () => {
    w.storylinePendingChapter.findUnique.mockResolvedValue(link() as never);
    await expect(removePendingChapter({ postId: 900, userId: OWNER })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(removePendingChapter({ postId: 900, userId: MODERATOR })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(w.storylinePendingChapter.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses a published post, scheduled ones included', async () => {
    for (const publishedAt of [new Date('2026-10-01'), new Date('2099-01-01')]) {
      w.storylinePendingChapter.findUnique.mockResolvedValue(link({ publishedAt }) as never);
      await expect(removePendingChapter({ postId: 900, userId: STRANGER })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This post is already published',
      });
    }
    expect(w.storylinePendingChapter.deleteMany).not.toHaveBeenCalled();
  });

  it('does nothing for a post with no link', async () => {
    w.storylinePendingChapter.findUnique.mockResolvedValue(null as never);
    await expect(removePendingChapter({ postId: 900, userId: STRANGER })).resolves.toEqual({
      removed: false,
    });
    expect(w.storylinePendingChapter.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps the link when the post is published between the read and the delete', async () => {
    w.storylinePendingChapter.findUnique.mockResolvedValue(link() as never);
    deletes(link({ publishedAt: new Date('2026-10-01') }));
    await expect(removePendingChapter({ postId: 900, userId: STRANGER })).resolves.toEqual({
      removed: false,
    });
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

    it('keeps a committed edit when logging it as a mod action fails', async () => {
      trackModActivity.mockReset();
      trackModActivity.mockRejectedValueOnce(new Error('pool timeout'));
      await expect(
        updateStoryline({ id: 10, title: 'x', userId: MODERATOR, isModerator: true })
      ).resolves.toBeDefined();
      expect(trackModActivity).toHaveBeenCalledTimes(1);
    });

    it("logs a moderator's edit as a mod action, and not the owner's", async () => {
      trackModActivity.mockReset();
      await updateStoryline({ id: 10, title: 'x', userId: OWNER });
      expect(trackModActivity).not.toHaveBeenCalled();
      await updateStoryline({ id: 10, title: 'x', userId: MODERATOR, isModerator: true });
      expect(trackModActivity).toHaveBeenCalledTimes(1);
      expect(trackModActivity).toHaveBeenCalledWith(MODERATOR, {
        entityType: 'storyline',
        entityId: 10,
        activity: 'update',
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
      w.storylineChapterEdge.findMany.mockResolvedValue([
        {
          parentChapterId: 20,
          storylineId: 10,
          chapter: {
            removedAt: null,
            post: { tosViolation: false, user: { bannedAt: null, deletedAt: null } },
          },
        },
      ] as never);
      w.storylineChapterEdge.updateMany.mockResolvedValue({ count: 1 } as never);
    });

    it('moves canon for the owner: clears the old one, then sets the new one', async () => {
      await setCanonChapter({ chapterId: 31, userId: OWNER });
      expect(w.storylineChapterEdge.updateMany.mock.calls.map((c) => c[0])).toEqual([
        { where: { parentChapterId: 20, canon: true }, data: { canon: false } },
        { where: { chapterId: 31, parentChapterId: 20 }, data: { canon: true } },
      ]);
    });

    it("logs a moderator's canon choice as a mod action, and not the owner's", async () => {
      trackModActivity.mockReset();
      await setCanonChapter({ chapterId: 31, userId: OWNER });
      expect(trackModActivity).not.toHaveBeenCalled();
      await setCanonChapter({ chapterId: 31, userId: MODERATOR, isModerator: true });
      expect(trackModActivity).toHaveBeenCalledTimes(1);
      expect(trackModActivity).toHaveBeenCalledWith(MODERATOR, {
        entityType: 'storyline',
        entityId: 10,
        activity: 'setCanon',
      });
    });

    it.each([
      ['an endorsed collaborator', COLLABORATOR],
      ['a stranger', STRANGER],
    ])('refuses %s', async (_name, userId) => {
      await expect(setCanonChapter({ chapterId: 31, userId })).rejects.toMatchObject(forbidden);
      expect(w.storylineChapterEdge.updateMany).not.toHaveBeenCalled();
    });

    // A moderator reads these chapters untombstoned and is offered the button on them; readers
    // would find a removed chapter at the head of the main path.
    const author = { bannedAt: null, deletedAt: null };
    it.each([
      ['removed', { removedAt: new Date(), post: { tosViolation: false, user: author } }],
      ['taken down', { removedAt: null, post: { tosViolation: true, user: author } }],
      [
        'by a banned author',
        {
          removedAt: null,
          post: { tosViolation: false, user: { ...author, bannedAt: new Date() } },
        },
      ],
      ['left without its post', { removedAt: null, post: null }],
      [
        'by a deleted account',
        {
          removedAt: null,
          post: { tosViolation: false, user: { ...author, deletedAt: new Date() } },
        },
      ],
    ])('refuses a chapter that is %s, even for a moderator', async (_name, chapter) => {
      w.storylineChapterEdge.findMany.mockResolvedValue([
        { parentChapterId: 20, storylineId: 10, chapter },
      ] as never);
      await expect(
        setCanonChapter({ chapterId: 31, userId: MODERATOR, isModerator: true })
      ).rejects.toThrow('A removed chapter cannot be the main route');
      expect(w.storylineChapterEdge.updateMany).not.toHaveBeenCalled();
    });

    it('accepts the same chapter once nothing about it is removed', async () => {
      w.storylineChapterEdge.findMany.mockResolvedValue([
        {
          parentChapterId: 20,
          storylineId: 10,
          chapter: { removedAt: null, post: { tosViolation: false, user: author } },
        },
      ] as never);
      await setCanonChapter({ chapterId: 31, userId: MODERATOR, isModerator: true });
      expect(w.storylineChapterEdge.updateMany).toHaveBeenCalledTimes(2);
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
        create: { storylineId: 10, userId: COLLABORATOR, acceptedAt: null },
        // Inviting someone again never resets an acceptance.
        update: {},
      });
    });

    describe('accepting an invitation', () => {
      const open = { storylineId: 10, userId: COLLABORATOR, acceptedAt: null };
      beforeEach(() =>
        w.storyline.findUnique.mockResolvedValue({ userId: OWNER, tosViolation: false } as never)
      );

      it("accepts only the caller's own open invitation", async () => {
        w.storylineCollaborator.updateMany.mockResolvedValue({ count: 1 } as never);
        await acceptStorylineInvite({ storylineId: 10, userId: COLLABORATOR });
        expect(w.storylineCollaborator.updateMany.mock.calls[0][0]).toEqual({
          where: open,
          data: { acceptedAt: expect.any(Date) },
        });
      });

      it('answers not found when there is no open invitation', async () => {
        w.storylineCollaborator.updateMany.mockResolvedValue({ count: 0 } as never);
        await expect(
          acceptStorylineInvite({ storylineId: 10, userId: STRANGER })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      });

      // Otherwise a blocked user could join, listed to everyone but the owner who blocked them.
      it('closes the invitation instead when the two have blocked each other since', async () => {
        blockedPairs = [[OWNER, COLLABORATOR]];
        await expect(
          acceptStorylineInvite({ storylineId: 10, userId: COLLABORATOR })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(w.storylineCollaborator.updateMany).not.toHaveBeenCalled();
        expect(w.storylineCollaborator.deleteMany).toHaveBeenCalledWith({ where: open });
      });

      it('is closed on a taken-down storyline', async () => {
        w.storyline.findUnique.mockResolvedValue({ userId: OWNER, tosViolation: true } as never);
        await expect(
          acceptStorylineInvite({ storylineId: 10, userId: COLLABORATOR })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(w.storylineCollaborator.updateMany).not.toHaveBeenCalled();
      });
    });

    // Decided with the Storylines lead: an endorsed collaborator's priced continuations skip the
    // owner's review, so endorsing stays the owner's even for a moderator. Removing is a safety action.
    it('refuses a moderator endorsing anyone, themselves included', async () => {
      for (const targetUserId of [COLLABORATOR, MODERATOR])
        await expect(
          addStorylineCollaborator({
            storylineId: 10,
            targetUserId,
            userId: MODERATOR,
            ...{ isModerator: true },
          })
        ).rejects.toMatchObject(forbidden);
      expect(w.storylineCollaborator.upsert).not.toHaveBeenCalled();
    });

    it('lets a moderator remove a collaborator, logged as a mod action', async () => {
      trackModActivity.mockReset();
      await removeStorylineCollaborator({
        storylineId: 10,
        targetUserId: COLLABORATOR,
        userId: MODERATOR,
        isModerator: true,
      });
      expect(w.storylineCollaborator.deleteMany).toHaveBeenCalledTimes(1);
      expect(trackModActivity).toHaveBeenCalledTimes(1);
      expect(trackModActivity).toHaveBeenCalledWith(MODERATOR, {
        entityType: 'storyline',
        entityId: 10,
        activity: 'removeCollaborator',
      });
    });

    it('refuses a stranger endorsing or removing someone', async () => {
      await expect(
        addStorylineCollaborator({ storylineId: 10, targetUserId: COLLABORATOR, userId: STRANGER })
      ).rejects.toMatchObject(forbidden);
      await expect(
        removeStorylineCollaborator({
          storylineId: 10,
          targetUserId: COLLABORATOR,
          userId: STRANGER,
        })
      ).rejects.toMatchObject(forbidden);
      expect(w.storylineCollaborator.upsert).not.toHaveBeenCalled();
      expect(w.storylineCollaborator.deleteMany).not.toHaveBeenCalled();
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
      { acceptedAt: new Date(), user: { id: COLLABORATOR, username: 'c', ...notBanned } },
      { acceptedAt: new Date(), user: { id: BLOCKED, username: 'b', ...notBanned } },
      {
        acceptedAt: new Date(),
        user: { id: 6, username: 'gone', bannedAt: new Date(), deletedAt: null },
      },
    ],
    chapters: [
      {
        id: 20,
        postId: 500,
        removedAt: null,
        post: {
          nsfwLevel: rootLevel,
          publishedAt: new Date(0),
          tosViolation: false,
          user: { bannedAt: null, deletedAt: null },
        },
      },
    ],
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

  describe('an invitation not yet accepted', () => {
    const INVITEE = 7;
    beforeEach(() =>
      r.storyline.findUnique.mockResolvedValue({
        ...row(),
        collaborators: [
          { acceptedAt: new Date(), user: { id: COLLABORATOR, username: 'c', ...notBanned } },
          { acceptedAt: null, user: { id: INVITEE, username: 'invitee', ...notBanned } },
        ],
      } as never)
    );

    it('is not shown to readers and gives the invitee no collaborator role', async () => {
      for (const viewer of [{ id: STRANGER }, { id: INVITEE }, undefined]) {
        const storyline = await getStoryline({ id: 10, viewer, browsingLevel: PG });
        expect(storyline.collaborators).toEqual([{ id: COLLABORATOR, username: 'c' }]);
        expect(storyline.contributors.map((c) => c.user.id)).not.toContain(INVITEE);
        expect(storyline.pendingCollaborators).toEqual([]);
        expect(storyline.viewerRole).toBeNull();
      }
    });

    it('is asked of the invitee alone', async () => {
      const invitee = await getStoryline({ id: 10, viewer: { id: INVITEE }, browsingLevel: PG });
      expect(invitee.viewerInvited).toBe(true);
      const stranger = await getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG });
      expect(stranger.viewerInvited).toBe(false);
    });

    it('is listed for the owner and moderators to manage', async () => {
      for (const viewer of [{ id: OWNER }, { id: MODERATOR, isModerator: true }]) {
        const storyline = await getStoryline({ id: 10, viewer, browsingLevel: PG });
        expect(storyline.pendingCollaborators).toEqual([{ id: INVITEE, username: 'invitee' }]);
      }
    });
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
    // Started before its first post. PG ceiling, so the level check alone would not hide it.
    ['with no chapter 1 yet', { ...row({ maxNsfwLevel: PG }), chapters: [] }, []],
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
    post: { nsfwLevel: level, userId: AUTHOR_OF_POSTS, tosViolation: false, user: notBanned },
    storyline: {
      id: 10,
      title: 'A story',
      userId: OWNER,
      maxNsfwLevel: NsfwLevel.R,
      tosViolation: false,
      nsfwLevel: 0,
      moderatorNsfwLevel: null,
      user: notBanned,
      chapters: [
        {
          removedAt: null,
          post: {
            nsfwLevel: NsfwLevel.PG,
            publishedAt: new Date(0),
            tosViolation: false,
            user: { bannedAt: null, deletedAt: null },
          },
        },
      ],
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

// Mod Lead ruling: a storyline whose chapter 1 is removed, unpublished or unrated is not public.
// Its owner, participants and moderators still see it, told why. Do not narrow the viewers here
// without that ruling changing.
describe('a storyline whose chapter 1 keeps it from the public', () => {
  const PG = NsfwLevel.PG;
  /** An accepted collaborator or a chapter author: what the participants read answers for. */
  const PARTICIPANT = 6;
  const shownPost = {
    nsfwLevel: PG,
    publishedAt: new Date(0),
    tosViolation: false,
    user: notBanned,
  };
  const root = (overrides: Record<string, unknown> = {}) => ({
    id: 1,
    postId: 101,
    removedAt: null,
    post: shownPost,
    ...overrides,
  });
  const cases: [string, Record<string, unknown>, StorylineRootHiddenReason][] = [
    ['its post is deleted', { postId: null, post: null }, 'removed'],
    ['it is removed', { removedAt: new Date() }, 'removed'],
    ['its post is taken down', { post: { ...shownPost, tosViolation: true } }, 'removed'],
    [
      "its post's author is banned",
      { post: { ...shownPost, user: { bannedAt: new Date(), deletedAt: null } } },
      'removed',
    ],
    [
      "its post's author is deleted",
      { post: { ...shownPost, user: { bannedAt: null, deletedAt: new Date() } } },
      'removed',
    ],
    [
      'its post is wholly Blocked',
      { post: { ...shownPost, nsfwLevel: NsfwLevel.Blocked } },
      'removed',
    ],
    ['its post is unpublished', { post: { ...shownPost, publishedAt: null } }, 'unpublished'],
    [
      'its post is scheduled',
      { post: { ...shownPost, publishedAt: new Date(Date.now() + 86_400_000) } },
      'unpublished',
    ],
    ['its post is unrated', { post: { ...shownPost, nsfwLevel: 0 } }, 'pendingRating'],
  ];
  const insiders = [
    ['owner', { id: OWNER }],
    ['moderator', { id: MODERATOR, isModerator: true }],
    ['participant', { id: PARTICIPANT }],
  ] as const;
  const outsiders = [
    ['stranger', { id: STRANGER }],
    ['signed-out reader', undefined],
  ] as const;

  beforeEach(() => {
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(
        strings.join('?').includes('"StorylineCollaborator" sc') && values[0] === PARTICIPANT
          ? [{ storylineId: 10 }]
          : []
      )) as never);
  });

  describe('its page', () => {
    const page = (rootOverrides: Record<string, unknown>) =>
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow({ maxNsfwLevel: PG }),
        collaborators: [],
        chapters: [root(rootOverrides)],
      } as never);

    it('is public, with no reason, when chapter 1 is shown', async () => {
      page({});
      for (const [, viewer] of [...outsiders, ...insiders])
        await expect(getStoryline({ id: 10, viewer, browsingLevel: PG })).resolves.toMatchObject({
          rootHiddenReason: null,
        });
    });

    it.each(cases)('when %s, is not found for the public', async (_n, overrides) => {
      page(overrides);
      for (const [name, viewer] of outsiders) {
        await expect(
          getStoryline({ id: 10, viewer, browsingLevel: PG }),
          name
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(assertStorylineVisible(10, viewer, PG), name).rejects.toMatchObject({
          code: 'NOT_FOUND',
        });
      }
    });

    it.each(cases)(
      'when %s, is shown to its owner, moderators and participants, saying why',
      async (_n, overrides, reason) => {
        page(overrides);
        for (const [name, viewer] of insiders) {
          await expect(
            getStoryline({ id: 10, viewer, browsingLevel: PG }),
            name
          ).resolves.toMatchObject({ rootHiddenReason: reason });
          await expect(assertStorylineVisible(10, viewer, PG), name).resolves.toBeDefined();
        }
      }
    );
  });

  // Continuing reaches the storyline by a chapter-2+ post, which stays public: refused as for a
  // post that is no chapter, the price and the submit would otherwise show it exists.
  describe('continuing it', () => {
    const LIVE_CHAPTER_AUTHOR = 7;
    const parentFor = (rootOverrides: Record<string, unknown>) => {
      w.storylineChapter.findUnique.mockResolvedValue({
        id: 1005,
        storylineId: 10,
        depth: 4,
        userId: AUTHOR_OF_POSTS,
        removedAt: null,
        storyline: {
          userId: OWNER,
          maxNsfwLevel: NsfwLevel.R,
          minorByScan: false,
          tosViolation: false,
          whoCanContinue: 'Anyone',
          chapters: [root(rootOverrides)],
        },
      } as never);
      w.storylineCollaborator.findUnique.mockImplementation((({ where }: never) =>
        Promise.resolve(
          (where as { storylineId_userId: { userId: number } }).storylineId_userId.userId ===
            PARTICIPANT
            ? { acceptedAt: new Date() }
            : null
        )) as never);
      // The query asks for a chapter that is not removed; the fake answers only for its author.
      w.storylineChapter.findFirst.mockImplementation((({ where }: never) =>
        Promise.resolve(
          (where as { userId: number; removedAt: null }).userId === LIVE_CHAPTER_AUTHOR &&
            (where as { removedAt: unknown }).removedAt === null
            ? { id: 1006 }
            : null
        )) as never);
    };
    const attempt = (placerId: number) => assertCanContinueStoryline({ parentPostId: 5, placerId });

    it('is open to anyone while chapter 1 is shown', async () => {
      parentFor({});
      await expect(attempt(STRANGER)).resolves.toMatchObject({ storylineId: 10 });
    });

    it.each(cases)(
      'when %s, refuses a stranger or a signed-out price check as no chapter, and not insiders',
      async (_n, overrides) => {
        parentFor(overrides);
        for (const placerId of [STRANGER, 0])
          await expect(attempt(placerId), `user ${placerId}`).rejects.toMatchObject({
            message: STORYLINE_REFUSALS.notAChapter,
          });
        for (const placerId of [OWNER, PARTICIPANT, LIVE_CHAPTER_AUTHOR])
          await expect(attempt(placerId), `user ${placerId}`).resolves.toMatchObject({
            storylineId: 10,
          });
      }
    );
  });

  describe('its pill', () => {
    // Chapter 5, itself shown to everyone: only chapter 1 can hide the storyline's title.
    const pill = (rootOverrides: Record<string, unknown>) =>
      r.storylineChapter.findMany.mockResolvedValue([
        {
          id: 1005,
          postId: 5,
          depth: 4,
          removedAt: null,
          post: { nsfwLevel: PG, userId: AUTHOR_OF_POSTS, tosViolation: false, user: notBanned },
          storyline: {
            id: 10,
            title: 'A story',
            userId: OWNER,
            // PG: with no rating from chapter 1 the story's level is its ceiling, and a
            // participant is still held to their browsing level.
            maxNsfwLevel: PG,
            minorByScan: false,
            tosViolation: false,
            nsfwLevel: 0,
            moderatorNsfwLevel: null,
            user: notBanned,
            chapters: [root(rootOverrides)],
          },
        },
      ] as never);
    const titleFor = async (viewer: { id: number; isModerator?: boolean } | undefined) =>
      (await getStorylinesForPosts({ postIds: [5], viewer, browsingLevel: PG }))[5]?.title;

    it('names the storyline on a chapter-5 image when chapter 1 is shown', async () => {
      pill({});
      for (const [name, viewer] of [...outsiders, ...insiders])
        expect(await titleFor(viewer), name).toBe('A story');
    });

    it.each(cases)(
      'when %s, is not shown on a chapter-5 image to the public, and is to insiders',
      async (_n, overrides) => {
        pill(overrides);
        for (const [name, viewer] of outsiders)
          expect(await titleFor(viewer), name).toBeUndefined();
        for (const [name, viewer] of insiders) expect(await titleFor(viewer), name).toBe('A story');
      }
    );
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
        { id: 1, postId: 101, depth: 0, parentIds: [] },
        { id: 2, postId: null, depth: 1, parentIds: [] },
        { id: 3, postId: 103, depth: 2, parentIds: [] },
        { id: 4, postId: 104, depth: 3, parentIds: [] },
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
      expect(chapters[2].post).toBeNull();
      expect(chapters[0].post).toMatchObject({ id: 101, username: `u${OWNER}` });
      // The fields the tombstone decides on are asked for.
      expect(r.post.findMany.mock.calls[0][0]).toMatchObject({
        select: { tosViolation: true, user: { select: { bannedAt: true, deletedAt: true } } },
      });
    });

    // A ban is the one removal no row on the chapter or post records: the post stays published and
    // untaken-down, only its author's account changed. The chapter must still read as removed to
    // everyone but moderators — the story's owner included — and must not cut the path short.
    it("tombstones a banned non-owner author's chapter, with the chapters after it reachable", async () => {
      r.post.findMany.mockResolvedValue([
        post(101, OWNER),
        post(103, STRANGER, { user: { username: 'gone', bannedAt: new Date(), deletedAt: null } }),
        post(104, COLLABORATOR),
      ] as never);
      const path = (viewer: { id: number; isModerator?: boolean }) =>
        getStorylinePath({ chapterId: 4, viewer, browsingLevel: NsfwLevel.PG });

      for (const viewer of [{ id: 99 }, { id: OWNER }]) {
        const { chapters } = await path(viewer);
        expect(chapters.map((c) => [c.chapterId, c.tombstone])).toEqual([
          [1, null],
          [2, 'deleted'],
          [3, 'removed'],
          [4, null],
        ]);
        expect(chapters[2].post).toBeNull();
        expect(chapters[3].post).toMatchObject({ id: 104 });
      }

      const { chapters: asModerator } = await path({ id: MODERATOR, isModerator: true });
      expect(asModerator[2]).toMatchObject({ tombstone: null, post: { id: 103 } });
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
      r.$queryRaw.mockResolvedValue([{ id: 4, postId: 104, depth: 3, parentIds: [] }] as never);
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
      [
        'with no chapter 1 yet',
        () =>
          // PG ceiling, so the level check alone would not hide it.
          r.storyline.findUnique.mockResolvedValue(
            storylineRow({ chapters: [], maxNsfwLevel: NsfwLevel.PG }) as never
          ),
      ],
    ])('when %s, has no path, children or map for them', async (_name, arrange) => {
      arrange();
      const read = { chapterId: 1, viewer: { id: STRANGER }, browsingLevel: NsfwLevel.PG };
      await expect(getStorylinePath(read)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(getStorylineChildren(read)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        getStorylineGraph({ id: 10, viewer: read.viewer, browsingLevel: read.browsingLevel })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(r.$queryRaw).not.toHaveBeenCalled();
      expect(r.storylineChapter.findMany).not.toHaveBeenCalled();
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
        _count: { parents: 1 },
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

    it("ranks a pending invitee's continuation with the community, not the endorsed", async () => {
      const all = [edge(13, COLLABORATOR, false, 3), edge(14, OWNER, true, 4)];
      r.storylineCollaborator.findMany.mockImplementation((({
        where,
      }: {
        where: { acceptedAt?: unknown };
      }) => Promise.resolve(where.acceptedAt ? [] : [{ userId: COLLABORATOR }])) as never);
      r.storylineChapterEdge.findFirst.mockResolvedValue(all[1] as never);
      r.storylineChapterEdge.findMany.mockImplementation((({
        where,
      }: {
        where: { chapter?: { userId?: { in: number[] } } };
      }) =>
        Promise.resolve(
          where.chapter
            ? all.filter((e) => where.chapter?.userId?.in.includes(e.chapter.userId))
            : all
        )) as never);

      const children = await getStorylineChildren({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: NsfwLevel.PG,
        readersByChapterId: new Map(),
      });
      expect(children.map((c) => [c.chapterId, c.rank])).toEqual([
        [14, 'canon'],
        [13, 'community'],
      ]);
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

  it('gives every way on its count and share from the first choice, by default', async () => {
    choices([
      [11, 12],
      [12, 7],
    ]);
    await expect(getStorylineForkShares(read)).resolves.toEqual({
      enough: true,
      total: 19,
      minChoices: 1,
      counts: { 11: 12, 12: 7 },
      shares: { 11: 12 / 19, 12: 7 / 19 },
    });
    expect(w.storylineBranchChoice.groupBy.mock.calls[0][0]).toMatchObject({
      by: ['chapterId'],
      where: { parentChapterId: 1 },
    });
  });

  it('withholds counts and shares below a raised STORYLINE_SHARE_MIN_CHOICES, then shows them', async () => {
    setEnv({ STORYLINE_SHARE_MIN_CHOICES: '5' });
    choices([
      [11, 3],
      [12, 1],
    ]);
    await expect(getStorylineForkShares(read)).resolves.toEqual({
      enough: false,
      total: 4,
      minChoices: 5,
      counts: {},
      shares: {},
    });
    choices([
      [11, 4],
      [12, 1],
    ]);
    await expect(getStorylineForkShares(read)).resolves.toEqual({
      enough: true,
      total: 5,
      minChoices: 5,
      counts: { 11: 4, 12: 1 },
      shares: { 11: 0.8, 12: 0.2 },
    });
  });

  it('falls back to a minimum of 1 for an invalid STORYLINE_SHARE_MIN_CHOICES', async () => {
    setEnv({ STORYLINE_SHARE_MIN_CHOICES: '0' });
    choices([[11, 1]]);
    await expect(getStorylineForkShares(read)).resolves.toEqual({
      enough: true,
      total: 1,
      minChoices: 1,
      counts: { 11: 1 },
      shares: { 11: 1 },
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

  it("records a reader's latest choice, only for a real way on, and writes the new counts through", async () => {
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
    expect(setFetchThroughCache).not.toHaveBeenCalled();

    w.storylineChapterEdge.findUnique.mockResolvedValue({ chapterId: 12 } as never);
    w.storylineBranchChoice.groupBy.mockResolvedValue([
      { chapterId: 12, _count: { _all: 3 } },
    ] as never);
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
    expect(setFetchThroughCache).toHaveBeenCalledTimes(1);
    expect(setFetchThroughCache).toHaveBeenCalledWith('packed:caches:storyline-fork-counts:1', [
      [12, 3],
    ]);
    // The counts written are read after the choice, from the primary, so they include it.
    expect(w.storylineBranchChoice.groupBy.mock.calls[0][0]).toMatchObject({
      where: { parentChapterId: 1 },
    });
    expect(w.storylineBranchChoice.groupBy.mock.invocationCallOrder[0]).toBeGreaterThan(
      w.storylineBranchChoice.upsert.mock.invocationCallOrder[0]
    );
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
      collaborators: [{ acceptedAt: new Date(), user: user(COLLABORATOR) }],
    } as never);
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = sqlOfRaw(strings, values);
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
          { id: 1, postId: 101, depth: 0, parentIds: [] },
          { id: 2, postId: null, depth: 1, parentIds: [] },
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
      { id: 2, postId: 102, depth: 1, parentIds: [] },
      { id: 3, postId: 103, depth: 2, parentIds: [] },
      { id: 4, postId: 104, depth: 3, parentIds: [] },
      { id: 5, postId: 105, depth: 4, parentIds: [] },
      { id: 6, postId: 106, depth: 5, parentIds: [] },
      { id: 7, postId: 107, depth: 6, parentIds: [] },
      { id: 8, postId: 108, depth: 7, parentIds: [] },
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
    r.$queryRaw.mockResolvedValue([{ id: 2, postId: 102, depth: 1, parentIds: [] }] as never);
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
    // The walk is the shared main-route fragment, composed into the query as Postgres gets it.
    const composedSql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    const sql = composedSql.sql;
    expect(sql).toContain('WHERE c.id = ?');
    expect(sql).toContain('e."parentChapterId" = main.id AND e.canon');
    expect(sql).toContain('WHERE main.hops < ?');
    // Route order: across a rejoin, depth (the first-parent distance) does not rise one per step.
    expect(sql).toContain('FROM main ORDER BY hops');
    expect(composedSql.values).toEqual([2, 199]);
  });

  it('serves nothing when the story is outside the reader level', async () => {
    r.storyline.findUnique.mockResolvedValue(
      storylineRow({
        chapters: [
          {
            id: 1,
            postId: 101,
            removedAt: null,
            post: {
              nsfwLevel: NsfwLevel.X,
              publishedAt: new Date(0),
              tosViolation: false,
              user: { bannedAt: null, deletedAt: null },
            },
          },
        ],
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

  /**
   * Answers the page read with `rows`, the first-image read with a cover for each post asked, and
   * the chosen-cover read with `picked` (as the gate and the chapter they are in would return).
   */
  const answer = (rows: ReturnType<typeof feedRow>[], picked: Record<string, unknown>[] = []) =>
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const composed = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      if (composed.sql.includes('DISTINCT ON (i."postId")')) {
        const postIds = composed.values[0] as number[];
        return Promise.resolve(postIds.map(cover));
      }
      if (composed.sql.includes('WHERE i.id = ANY(')) return Promise.resolve(picked);
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
    r.user.findMany.mockResolvedValue([] as never);
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

  // hiddenTags also lists every tag rated above PG (9 here) and hiddenImages every image the
  // reader voted a tag onto (78, 79): as the image feeds, only tags the reader hid count, and an
  // image hidden through a tag only while that tag is one of them.
  it('asks for covers from chapter 1 posts only, at the reader level, the ceiling, minus hidden', async () => {
    getAllHiddenForUser.mockResolvedValue({
      hiddenImages: [
        { id: 77, hidden: true },
        { id: 78, tagId: 5 },
        { id: 79, tagId: 9 },
      ],
      hiddenTags: [
        { id: 5, hidden: true },
        { id: 6, hidden: true },
        { id: 9, name: 'suggestive', nsfwLevel: NsfwLevel.PG13 },
      ],
    });
    answer([feedRow(1)]);
    await feed({ id: STRANGER });
    const { text: sql, values } = sqlAt(1);
    // Chapter 1's post, as the page read gave it, is the only post asked about. The join serves
    // any chapter (the page and reading rows ask about later ones), so it filters on no depth.
    expect(sql).toContain(
      'JOIN "StorylineChapter" c ON c."postId" = i."postId" JOIN "Storyline" st ON st.id = c."storylineId"'
    );
    expect(sql).not.toContain('depth');
    expect(sql).toContain(
      `i.ingestion = 'Scanned' AND i."tosViolation" = false AND i."needsReview" IS NULL`
    );
    expect(sql).toContain('AND i.minor = false AND i.poi = false');
    expect(sql).toContain('AND (i."nsfwLevel" & ?::int) <> 0');
    expect(sql).toContain(
      'AND (i."nsfwLevel" & ~((CASE WHEN st."minorByScan" THEN LEAST(st."maxNsfwLevel", ?) ELSE st."maxNsfwLevel" END) * 2 - 1)) = 0'
    );
    expect(sql).toContain('AND i.id <> ALL(?::int[])');
    // Whitespace-insensitive, anchored on the NOT EXISTS so a negation dropped in front is caught.
    expect(sql).toContain(
      'AND (NOT EXISTS ( SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id AND toi."tagId" = ANY(?::int[]) AND toi.disabled = false ) OR i."userId" = ?)'
    );
    expect(sql).toContain('ORDER BY i."postId", i.index NULLS LAST, i.id');
    // The PG-13 after the reader's level is the minor ceiling in the ceiling's CASE.
    expect(values).toEqual([
      [501],
      STRANGER,
      NsfwLevel.PG,
      NsfwLevel.PG13,
      [77, 78],
      [5, 6],
      STRANGER,
    ]);
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
    expect(text).toContain(`AND (p.id IS NULL OR p.availability <> 'Private' OR p."userId" = ?)`);
    expect(values.filter((v) => v === STRANGER)).toHaveLength(2);
  });

  it('adds the browsing-settings tag exclusions for the reader level to the hidden tags', async () => {
    enforceBlockedBrowsingTags.mockImplementation((async (input: { excludedTagIds?: number[] }) => {
      input.excludedTagIds = [6, 9];
      return { emptyResult: false };
    }) as never);
    getAllHiddenForUser.mockResolvedValue({
      hiddenImages: [],
      hiddenTags: [
        { id: 5, hidden: true },
        { id: 6, hidden: true },
      ],
    });
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

describe('a chapter whose placement was removed', () => {
  const REMOVED_AT = new Date('2026-10-14');
  // The removed chapters below are by STRANGER, so `author` is their author and `reader` is not.
  const viewers = {
    reader: { id: 99 },
    author: { id: STRANGER },
    moderator: { id: MODERATOR, isModerator: true },
  };
  const post = (id: number, userId: number) => ({
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel: NsfwLevel.PG,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    user: { username: `u${userId}`, ...notBanned },
  });
  /** A raw query's text as Postgres gets it. */
  const rawSql = (call: unknown) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    return Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
  };

  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    w.storyline.findUnique.mockResolvedValue(storylineRow() as never);
  });

  it('is a removed tombstone in the reading path, for its author too, but not for moderators', async () => {
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 2 } as never);
    r.$queryRaw.mockResolvedValue([
      { id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] },
      { id: 2, postId: 102, depth: 1, removedAt: REMOVED_AT, parentIds: [] },
      { id: 3, postId: 103, depth: 2, removedAt: null, parentIds: [] },
    ] as never);
    r.post.findMany.mockResolvedValue([
      post(101, OWNER),
      post(102, STRANGER),
      post(103, OWNER),
    ] as never);
    const tombstones = async (viewer: { id: number; isModerator?: boolean }) =>
      (await getStorylinePath({ chapterId: 3, viewer, browsingLevel: NsfwLevel.PG })).chapters.map(
        (c) => c.tombstone
      );

    expect(await tombstones(viewers.reader)).toEqual([null, 'removed', null]);
    expect(await tombstones(viewers.author)).toEqual([null, 'removed', null]);
    expect(await tombstones(viewers.moderator)).toEqual([null, null, null]);
    // Both arms of the walk carry the column, or every chapter above the target reads as kept.
    const sql = rawSql(r.$queryRaw.mock.calls[0]);
    expect(sql).toContain('SELECT c.id, c."postId", c.depth, c."removedAt", 0 AS hops');
    expect(sql).toContain('SELECT p.id, p."postId", p.depth, p."removedAt", path.hops + 1');
    expect(sql).toContain('SELECT path.id, path."postId", path.depth, path."removedAt"');
    // Selected only, never filtered on: the walk must reach past a removed chapter.
    expect(sql.match(/"removedAt"/g)).toHaveLength(3);
  });

  it('is a removed tombstone on the main route', async () => {
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    r.$queryRaw.mockResolvedValue([
      { id: 2, postId: 102, depth: 1, removedAt: null, parentIds: [] },
      { id: 3, postId: 103, depth: 2, removedAt: REMOVED_AT, parentIds: [] },
    ] as never);
    r.post.findMany.mockResolvedValue([post(102, OWNER), post(103, STRANGER)] as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([] as never);
    const ahead = (viewer: { id: number; isModerator?: boolean }) =>
      getStorylineCanonAhead({ chapterId: 2, viewer, browsingLevel: NsfwLevel.PG });
    expect((await ahead(viewers.reader)).map((c) => [c.chapterId, c.tombstone, c.post])).toEqual([
      [3, 'removed', null],
    ]);
    expect((await ahead(viewers.author)).map((c) => c.tombstone)).toEqual(['removed']);
    expect((await ahead(viewers.moderator)).map((c) => [c.tombstone, c.post?.id])).toEqual([
      [null, 103],
    ]);
    const sql = rawSql(r.$queryRaw.mock.calls[0]);
    expect(sql).toContain('SELECT c.id, c."postId", c.depth, c."removedAt", 0 AS hops');
    expect(sql).toContain('SELECT ch.id, ch."postId", ch.depth, ch."removedAt", main.hops + 1');
    expect(sql).toContain('SELECT main.id, main."postId", main.depth, main."removedAt"');
    expect(sql.match(/"removedAt"/g)).toHaveLength(3);
  });

  it('is a removed tombstone among the ways on, and asks for the column', async () => {
    r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
    r.storylineCollaborator.findMany.mockResolvedValue([] as never);
    r.storylineChapterEdge.findFirst.mockResolvedValue(null as never);
    const child = (id: number, removedAt: Date | null) => ({
      canon: false,
      chapter: {
        id,
        depth: 1,
        userId: STRANGER,
        createdAt: new Date('2026-10-02'),
        removedAt,
        post: post(id + 100, STRANGER),
        _count: { parents: 1 },
      },
    });
    r.storylineChapterEdge.findMany.mockResolvedValue([
      child(11, null),
      child(12, REMOVED_AT),
    ] as never);
    const tombstones = async (viewer: { id: number; isModerator?: boolean }) =>
      (
        await getStorylineChildren({
          chapterId: 1,
          viewer,
          browsingLevel: NsfwLevel.PG,
          readersByChapterId: new Map(),
        })
      ).map((c) => [c.chapterId, c.tombstone]);
    expect(await tombstones(viewers.reader)).toEqual([
      [11, null],
      [12, 'removed'],
    ]);
    expect(await tombstones(viewers.author)).toEqual([
      [11, null],
      [12, 'removed'],
    ]);
    expect(await tombstones(viewers.moderator)).toEqual([
      [11, null],
      [12, null],
    ]);
    expect(r.storylineChapterEdge.findMany.mock.calls[0][0]).toMatchObject({
      select: { chapter: { select: { removedAt: true } } },
    });
  });

  // Every chapter the reading path shows as removed, not only one removed itself: otherwise the post
  // says it is a chapter and the storyline shows a tombstone where it should be.
  it('gives no storyline pill to anyone but moderators', async () => {
    const chapter = (
      postId: number,
      removedAt: Date | null,
      post: { tosViolation?: boolean; user?: typeof notBanned } = {}
    ) => ({
      id: postId + 1000,
      postId,
      depth: 1,
      removedAt,
      post: {
        nsfwLevel: NsfwLevel.PG,
        userId: STRANGER,
        tosViolation: false,
        user: notBanned,
        ...post,
      },
      storyline: {
        id: 10,
        title: 'A story',
        userId: OWNER,
        maxNsfwLevel: NsfwLevel.R,
        tosViolation: false,
        nsfwLevel: 0,
        moderatorNsfwLevel: null,
        user: notBanned,
        chapters: [
          {
            removedAt: null,
            post: {
              nsfwLevel: NsfwLevel.PG,
              publishedAt: new Date(0),
              tosViolation: false,
              user: { bannedAt: null, deletedAt: null },
            },
          },
        ],
      },
    });
    r.storylineChapter.findMany.mockResolvedValue([
      chapter(1, null),
      chapter(2, REMOVED_AT),
      chapter(3, null, { tosViolation: true }),
      chapter(4, null, { user: { ...notBanned, bannedAt: REMOVED_AT } }),
      chapter(5, null, { user: { ...notBanned, deletedAt: REMOVED_AT } }),
    ] as never);
    const pills = async (viewer: { id: number; isModerator?: boolean }) =>
      Object.keys(
        await getStorylinesForPosts({
          postIds: [1, 2, 3, 4, 5],
          viewer,
          browsingLevel: NsfwLevel.PG,
        })
      );
    expect(await pills(viewers.reader)).toEqual(['1']);
    expect(await pills(viewers.author)).toEqual(['1']);
    expect(await pills(viewers.moderator)).toEqual(['1', '2', '3', '4', '5']);
    expect(r.storylineChapter.findMany.mock.calls[0][0]).toMatchObject({
      select: {
        removedAt: true,
        post: {
          select: { tosViolation: true, user: { select: { bannedAt: true, deletedAt: true } } },
        },
      },
    });
  });

  it('credits nobody and counts no contributor through it', async () => {
    r.storyline.findUnique.mockResolvedValue({ ...storylineRow(), collaborators: [] } as never);
    r.$queryRaw.mockResolvedValue([] as never);
    r.user.findMany.mockResolvedValue([] as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([] as never);
    await getStoryline({ id: 10, viewer: viewers.reader, browsingLevel: NsfwLevel.PG });
    const sqls = r.$queryRaw.mock.calls.map(rawSql);
    const counts = sqls.find((sql) => sql.includes('COUNT(DISTINCT'));
    const credits = sqls.find((sql) => sql.includes('GROUP BY c."userId"'));
    expect(counts).toMatch(/FILTER \(WHERE p\.id IS NOT NULL AND\s+c\."removedAt" IS NULL\s+AND/);
    expect(credits).toMatch(/AND\s+c\."removedAt" IS NULL\s+AND p\."tosViolation" = false/);
  });

  it("leaves it out of the owner's ceiling warning", async () => {
    w.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    const level = (depth: number, nsfwLevel: number, removedAt: Date | null) => ({
      depth,
      userId: STRANGER,
      nsfwLevel,
      publishedAt: new Date('2026-10-01'),
      tosViolation: false,
      bannedAt: null,
      deletedAt: null,
      removedAt,
    });
    r.$queryRaw.mockResolvedValue([
      { ...level(0, NsfwLevel.PG, null), userId: OWNER },
      level(1, NsfwLevel.R, null),
      level(1, NsfwLevel.X, REMOVED_AT),
    ] as never);
    await expect(getStorylineChapterLevels({ id: 10, userId: OWNER })).resolves.toEqual({
      rootNsfwLevel: NsfwLevel.PG,
      chapterLevels: [NsfwLevel.R],
    });
    expect(rawSql(r.$queryRaw.mock.calls[0])).toContain(
      'u."bannedAt", u."deletedAt", c."removedAt"'
    );
  });

  it('cannot be continued, and nothing is written', async () => {
    w.storylineChapter.findUnique.mockImplementation((({ where }: { where: { postId?: number } }) =>
      Promise.resolve(
        where.postId === 500
          ? {
              id: 20,
              storylineId: 10,
              depth: 1,
              userId: PARENT_AUTHOR,
              removedAt: REMOVED_AT,
              storyline: {
                userId: OWNER,
                maxNsfwLevel: NsfwLevel.R,
                tosViolation: false,
                whoCanContinue: 'Anyone',
                chapters: shownRootChapters,
              },
            }
          : null
      )) as never);
    w.post.findUnique.mockResolvedValue(publishedPost() as never);
    await expect(
      writeChapterEdgeForPlacement(
        { placementId: 77, parentPostId: 500, postId: 600, placerId: STRANGER },
        tx
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'storyline: that post is not a chapter of an open storyline',
    });
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(w.storylineChapterEdge.create).not.toHaveBeenCalled();
    expect(
      w.storylineChapter.findUnique.mock.calls.find(
        (c) => (c[0] as { where: { postId?: number } }).where.postId === 500
      )?.[0]
    ).toMatchObject({ select: { removedAt: true } });
  });

  it('cannot be continued by the owner directly either', async () => {
    w.storylineChapter.findUnique.mockResolvedValue({
      id: 20,
      storylineId: 10,
      depth: 1,
      removedAt: REMOVED_AT,
      storyline: { userId: OWNER, maxNsfwLevel: NsfwLevel.R, tosViolation: false },
    } as never);
    w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
    await expect(
      addOwnerChapter({ parentChapterId: 20, postId: 600, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(w.storylineChapter.create).not.toHaveBeenCalled();
    expect(w.storylineChapter.findUnique.mock.calls[0][0]).toMatchObject({
      select: { removedAt: true },
    });
  });

  it('cannot be made the main route, and canon is left as it was', async () => {
    w.storylineChapterEdge.findMany.mockResolvedValue([
      { parentChapterId: 20, storylineId: 10, chapter: { removedAt: REMOVED_AT } },
    ] as never);
    await expect(setCanonChapter({ chapterId: 31, userId: OWNER })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(w.storylineChapterEdge.updateMany).not.toHaveBeenCalled();
    expect(w.storylineChapterEdge.findMany.mock.calls[0][0]).toMatchObject({
      select: { chapter: { select: { removedAt: true } } },
    });
  });
});

describe('covers and cast', () => {
  const PG = NsfwLevel.PG;
  /** A raw query as Postgres gets it, whitespace collapsed. */
  const composed = (call: unknown) => {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    const sql = Prisma.sql(strings, ...(values as Prisma.Sql[]));
    return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
  };
  const rawCalls = () => r.$queryRaw.mock.calls.map(composed);
  const isFirstImageRead = (text: string) => text.includes('DISTINCT ON (i."postId")');
  const isChosenImageRead = (text: string) => text.includes('AS pick("storylineId", "imageId")');
  const image = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    url: `img-${id}`,
    type: 'image',
    nsfwLevel: PG,
    hash: null,
    width: 100,
    height: 200,
    userId: OWNER,
    minor: false,
    poi: false,
    ...extra,
  });
  const picked = (id: number, extra: Record<string, unknown> = {}) => ({
    ...image(id),
    storylineId: 10,
    postId: 500 + id,
    chapterId: id,
    storylineUserId: OWNER,
    uploaderIsModerator: false,
    uploaderBannedAt: null,
    uploaderDeletedAt: null,
    // Listed as uploaded here; only read for a pick in no post.
    uploadedHere: true,
    postUserId: OWNER,
    postNsfwLevel: PG,
    publishedAt: new Date('2026-10-01'),
    postTosViolation: false,
    removedAt: null,
    bannedAt: null,
    deletedAt: null,
    maxNsfwLevel: NsfwLevel.R,
    ...extra,
  });
  const chapterPost = (id: number, userId: number, overrides: Record<string, unknown> = {}) => ({
    id,
    userId,
    title: `post ${id}`,
    nsfwLevel: PG,
    publishedAt: new Date('2026-10-01'),
    tosViolation: false,
    user: { id: userId, username: `u${userId}`, image: null, cosmetics: [], ...notBanned },
    ...overrides,
  });

  /**
   * Raw reads by shape: the chapter walk or path returns `walk`, the first-image read a first
   * image for each post asked (image id = post id + 1000), the chosen read `chosenRows`.
   */
  const answerRaw = (walk: unknown[], chosenRows: unknown[] = []) =>
    r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const { text, values: bound } = composed([strings, ...values]);
      if (isFirstImageRead(text))
        return Promise.resolve(
          (bound[0] as number[]).map((postId) => ({ postId, ...image(postId + 1000) }))
        );
      if (isChosenImageRead(text)) return Promise.resolve(chosenRows);
      if (text.includes('WITH RECURSIVE')) return Promise.resolve(walk);
      return Promise.resolve([]);
    }) as never);

  beforeEach(() => {
    r.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    w.storyline.findUnique.mockResolvedValue(storylineRow() as never);
    r.storylineChapterEdge.groupBy.mockResolvedValue([] as never);
    r.user.findMany.mockResolvedValue([] as never);
  });

  describe('choosing a cover or banner', () => {
    /**
     * Image -> the chapter it is in (storyline, author, removed), or for `upload` an image in no
     * post, owned by `userId`; `post` is a post that is no chapter.
     */
    const images = (
      rows: Record<
        number,
        {
          storylineId?: number;
          userId: number;
          level?: number;
          removed?: boolean;
          minor?: boolean;
          poi?: boolean;
          upload?: boolean;
          post?: boolean;
          ingestion?: string;
          tosViolation?: boolean;
        }
      >
    ) =>
      w.image.findMany.mockImplementation((({ where }: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          where.id.in
            .filter((id) => rows[id])
            .map((id) => ({
              id,
              userId: rows[id].userId,
              postId: rows[id].upload ? null : 500 + id,
              ingestion: rows[id].ingestion ?? 'Scanned',
              tosViolation: !!rows[id].tosViolation,
              nsfwLevel: rows[id].level ?? PG,
              minor: !!rows[id].minor,
              poi: !!rows[id].poi,
              post: rows[id].upload
                ? null
                : {
                    storylineChapter: rows[id].post
                      ? null
                      : {
                          storylineId: rows[id].storylineId ?? 10,
                          userId: rows[id].userId,
                          removedAt: rows[id].removed ? new Date() : null,
                        },
                  },
            }))
        )) as never);

    beforeEach(() => {
      w.storylineCollaborator.findMany.mockResolvedValue([{ userId: COLLABORATOR }] as never);
      w.storyline.update.mockResolvedValue({} as never);
      // The array form a pick's save uses; a callback runs on the same client, as on create.
      w.$transaction.mockImplementation(((arg: unknown) =>
        typeof arg === 'function' ? arg(w) : Promise.all(arg as unknown[])) as never);
      resolveCoverImageId.mockReset();
      images({
        1: { userId: OWNER },
        2: { userId: COLLABORATOR },
        3: { userId: STRANGER },
        4: { userId: OWNER, storylineId: 99 },
        5: { userId: OWNER, removed: true },
        6: { userId: OWNER, level: NsfwLevel.X },
        7: { userId: OWNER, level: 0 },
        8: { userId: OWNER, minor: true },
        9: { userId: OWNER, poi: true },
        // Uploads (in no post) and a posted image that is no chapter.
        20: { userId: OWNER, upload: true },
        21: { userId: STRANGER, upload: true },
        22: { userId: MODERATOR, upload: true },
        23: { userId: OWNER, upload: true, ingestion: 'Pending', level: 0 },
        24: { userId: OWNER, upload: true, level: NsfwLevel.X },
        25: { userId: OWNER, upload: true, tosViolation: true },
        26: { userId: OWNER, upload: true, ingestion: 'Blocked' },
        27: { userId: OWNER, upload: true, minor: true },
        28: { userId: OWNER, post: true },
      });
    });

    it("takes an image from the owner's chapters or an endorsed collaborator's, and writes it", async () => {
      await updateStoryline({
        id: 10,
        userId: OWNER,
        coverImageId: 1,
        heroImageId: 2,
        heroImagePosition: 30,
      });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
        data: { coverImageId: 1, heroImageId: 2, heroImagePosition: 30 },
        select: { coverImageId: true, heroImageId: true, heroImagePosition: true },
      });
      expect(w.storylineCollaborator.findMany.mock.calls[0][0]).toMatchObject({
        where: { storylineId: 10 },
      });
      expect(w.image.findMany.mock.calls[0][0]).toMatchObject({
        select: {
          nsfwLevel: true,
          post: {
            select: {
              storylineChapter: { select: { storylineId: true, userId: true, removedAt: true } },
            },
          },
        },
      });
    });

    it.each([
      ['a community chapter', 3, /own chapters, an endorsed collaborator's/],
      ["another storyline's chapter", 4, /own chapters, an endorsed collaborator's/],
      ['a removed chapter', 5, /own chapters, an endorsed collaborator's/],
      ['no chapter at all', 404, /own chapters, an endorsed collaborator's/],
      ["someone else's upload", 21, /own chapters, an endorsed collaborator's, or one you upload/],
      ["a moderator's upload, picked by the owner", 22, /or one you upload/],
      ['a post of the owner that is no chapter', 28, /or one you upload/],
      ['above the ceiling', 6, /above the storyline's maximum rating/],
      ['not rated yet', 7, /not been rated yet/],
      ['a minor', 8, /cannot be used as a cover or banner/],
      ['a real person', 9, /cannot be used as a cover or banner/],
    ])(
      'refuses an image from %s, as cover or banner, and writes nothing',
      async (_n, id, error) => {
        for (const pick of [{ coverImageId: id }, { heroImageId: id }]) {
          await expect(updateStoryline({ id: 10, userId: OWNER, ...pick })).rejects.toMatchObject({
            code: 'BAD_REQUEST',
            message: expect.stringMatching(error),
          });
        }
        expect(w.storyline.update).not.toHaveBeenCalled();
      }
    );

    // The mock answers like the table: COLLABORATOR's row is still a pending invitation.
    it('refuses an image from an invitee who has not accepted', async () => {
      w.storylineCollaborator.findMany.mockImplementation((({
        where,
      }: {
        where: { acceptedAt?: unknown };
      }) => Promise.resolve(where.acceptedAt ? [] : [{ userId: COLLABORATOR }])) as never);
      await expect(
        updateStoryline({ id: 10, userId: OWNER, coverImageId: 2 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.storyline.update).not.toHaveBeenCalled();
    });

    it('judges the pick against the ceiling being set in the same edit', async () => {
      await expect(
        updateStoryline({ id: 10, userId: OWNER, coverImageId: 6, maxNsfwLevel: NsfwLevel.X })
      ).resolves.toBeDefined();
      await expect(
        updateStoryline({ id: 10, userId: OWNER, coverImageId: 1, maxNsfwLevel: NsfwLevel.PG })
      ).resolves.toBeDefined();
    });

    /** Uploads a file the server makes image `imageId` of the caller, and picks it. */
    const upload = (
      imageId: number,
      caller: { userId: number; isModerator?: boolean },
      slot = 'coverUpload'
    ) => {
      resolveCoverImageId.mockResolvedValueOnce(imageId);
      return updateStoryline({ id: 10, ...caller, [slot]: { url: UPLOAD_URL, type: 'image' } });
    };

    it('takes an image its owner uploads, as cover or banner, and records it as uploaded here', async () => {
      await upload(20, { userId: OWNER });
      await upload(20, { userId: OWNER }, 'heroUpload');
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: 20 } });
      expect(w.storyline.update.mock.calls[1][0]).toMatchObject({ data: { heroImageId: 20 } });
      expect(w.storylineCoverUpload.createMany.mock.calls[0][0]).toEqual({
        data: [{ storylineId: 10, imageId: 20 }],
        skipDuplicates: true,
      });
    });

    it("takes a moderator's own upload on someone else's storyline", async () => {
      await upload(22, { userId: MODERATOR, isModerator: true });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: 22 } });
    });

    // An image in no post is taken only when this request uploaded it.
    it("refuses its owner's image in no post picked by id, and records nothing", async () => {
      await expect(updateStoryline({ id: 10, userId: OWNER, coverImageId: 20 })).rejects.toThrow(
        /or one you upload/
      );
      expect(w.storyline.update).not.toHaveBeenCalled();
      expect(w.storylineCoverUpload.createMany).not.toHaveBeenCalled();
    });

    it('does not judge again an uploaded pick sent back unchanged', async () => {
      w.storyline.findUnique.mockResolvedValue({
        ...storylineRow(),
        coverImageId: 20,
        heroImageId: null,
        heroImagePosition: 50,
      } as never);
      await updateStoryline({ id: 10, userId: OWNER, coverImageId: 20 });
      expect(w.image.findMany).not.toHaveBeenCalled();
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: 20 } });
    });

    // A refusal would tell the uploader their scan's verdict; the read gate keeps it hidden instead.
    it.each([
      ['rated above the ceiling', 24],
      ['taken down', 25],
      ['blocked by its scan', 26],
      ['of a minor', 27],
    ])("takes its owner's own upload %s, without a word", async (_n, id) => {
      await upload(id, { userId: OWNER });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: id } });
    });

    it('keeps an upload whose scan has not finished, unlike an unrated chapter image', async () => {
      await upload(23, { userId: OWNER });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: 23 } });
      await expect(updateStoryline({ id: 10, userId: OWNER, coverImageId: 7 })).rejects.toThrow(
        /not been rated yet/
      );
    });

    // A fresh upload's key is behind no image yet.
    it('refuses an upload whose file is already an image, even its own, and makes nothing', async () => {
      w.image.findFirst.mockResolvedValueOnce({ id: 5 } as never);
      await expect(
        updateStoryline({ id: 10, userId: OWNER, coverUpload: { url: UPLOAD_URL, type: 'image' } })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: COVER_IMAGE_UNAVAILABLE_MESSAGE });
      expect(w.image.findFirst.mock.calls[0][0]).toMatchObject({ where: { url: UPLOAD_URL } });
      expect(w.image.findFirst.mock.calls[0][0].where).not.toHaveProperty('userId');
      expect(resolveCoverImageId).not.toHaveBeenCalled();
      expect(w.storyline.update).not.toHaveBeenCalled();
    });

    it('makes an uploaded file an image of the uploader, then picks it', async () => {
      await upload(20, { userId: OWNER });
      expect(resolveCoverImageId).toHaveBeenCalledWith({
        coverImage: { url: UPLOAD_URL, type: 'image' },
        userId: OWNER,
      });
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({ data: { coverImageId: 20 } });
    });

    it("refuses an upload in this request whose image is not the caller's", async () => {
      await expect(upload(21, { userId: OWNER })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/or one you upload/),
      });
      expect(w.storyline.update).not.toHaveBeenCalled();
    });

    it("holds a moderator to the owner's rule", async () => {
      await expect(
        updateStoryline({ id: 10, userId: MODERATOR, isModerator: true, coverImageId: 3 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await updateStoryline({ id: 10, userId: MODERATOR, isModerator: true, coverImageId: 1 });
      expect(w.storyline.update).toHaveBeenCalledTimes(1);
    });

    it('does not judge again a pick sent back unchanged, only one that changes', async () => {
      // Image 3 is now a community chapter's (its collaborator was removed): kept as it is.
      w.storyline.findUnique.mockResolvedValue({
        ...storylineRow(),
        coverImageId: 3,
        heroImageId: 3,
        heroImagePosition: 50,
      } as never);
      await updateStoryline({ id: 10, userId: OWNER, coverImageId: 3, heroImageId: 3 });
      expect(w.image.findMany).not.toHaveBeenCalled();
      // Moving the banner onto it from elsewhere is a new pick, and refused.
      w.storyline.findUnique.mockResolvedValue({
        ...storylineRow(),
        coverImageId: 3,
        heroImageId: 1,
        heroImagePosition: 50,
      } as never);
      await expect(
        updateStoryline({ id: 10, userId: OWNER, coverImageId: 3, heroImageId: 3 })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.image.findMany.mock.calls[0][0]).toMatchObject({ where: { id: { in: [3] } } });
      expect(w.storyline.findUnique.mock.calls[0][0]).toMatchObject({
        select: { coverImageId: true, heroImageId: true },
      });
    });

    it('clears a pick with null without checking anything', async () => {
      await updateStoryline({ id: 10, userId: OWNER, coverImageId: null, heroImageId: null });
      expect(w.image.findMany).not.toHaveBeenCalled();
      expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
        data: { coverImageId: null, heroImageId: null },
      });
    });

    it('refuses a stranger before looking at any image', async () => {
      await expect(
        updateStoryline({ id: 10, userId: STRANGER, coverImageId: 1 })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(w.image.findMany).not.toHaveBeenCalled();
    });

    describe('on create', () => {
      beforeEach(() => {
        w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
        w.storyline.create.mockResolvedValue({ id: 10 } as never);
        w.storylineChapter.create.mockResolvedValue({ id: 20 } as never);
      });
      const create = (picks: Record<string, unknown>) =>
        createStoryline({
          postId: 600,
          title: 'A story',
          maxNsfwLevel: NsfwLevel.R,
          userId: OWNER,
          ...picks,
        });

      it('takes an image of the post the storyline starts from, once chapter 1 exists', async () => {
        await create({ coverImageId: 1, heroImageId: 1, heroImagePosition: 80 });
        expect(w.storylineChapter.create.mock.invocationCallOrder[0]).toBeLessThan(
          w.image.findMany.mock.invocationCallOrder[0]
        );
        expect(w.storyline.update.mock.calls[0][0]).toEqual({
          where: { id: 10 },
          data: { coverImageId: 1, heroImageId: 1, heroImagePosition: 80 },
        });
      });

      it('refuses any other image and does not write it', async () => {
        await expect(create({ coverImageId: 3 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(w.storyline.update).not.toHaveBeenCalled();
      });

      it('saves a banner focus given on its own, without reading any image', async () => {
        await create({ heroImagePosition: 10 });
        expect(w.image.findMany).not.toHaveBeenCalled();
        expect(w.storyline.update.mock.calls[0][0]).toMatchObject({
          data: { heroImagePosition: 10 },
        });
      });

      it('reads and writes nothing more without picks', async () => {
        await create({});
        expect(w.image.findMany).not.toHaveBeenCalled();
        expect(w.storyline.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('first images on the reading rows', () => {
    it('gives each shown chapter of the path its first image, and a tombstone none, in one read', async () => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 2 } as never);
      answerRaw([
        { id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] },
        { id: 2, postId: 102, depth: 1, removedAt: null, parentIds: [] },
        { id: 3, postId: 103, depth: 2, removedAt: null, parentIds: [] },
      ]);
      r.post.findMany.mockResolvedValue([
        chapterPost(101, OWNER),
        chapterPost(102, STRANGER, { tosViolation: true }),
        chapterPost(103, COLLABORATOR),
      ] as never);
      const { chapters } = await getStorylinePath({
        chapterId: 3,
        viewer: { id: 99 },
        browsingLevel: PG,
      });
      expect(chapters.map((c) => [c.chapterId, c.tombstone, c.firstImage?.id ?? null])).toEqual([
        [1, null, 1101],
        [2, 'removed', null],
        [3, null, 1103],
      ]);
      const reads = rawCalls().filter((call) => isFirstImageRead(call.text));
      expect(reads).toHaveLength(1);
      // Only the chapters the reader is shown are asked about.
      expect(reads[0].values[0]).toEqual([101, 103]);
      expect(chapters[0].firstImage).toEqual(image(1101));
    });

    it('reads first images in one query however many chapters there are', async () => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 49 } as never);
      const rows = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          id: i + 1,
          postId: 100 + i,
          depth: i,
          removedAt: null,
          parentIds: i ? [i] : [],
        }));
      const queriesFor = async (n: number) => {
        r.$queryRaw.mockClear();
        answerRaw(rows(n));
        r.post.findMany.mockResolvedValue(
          rows(n).map((row) => chapterPost(row.postId, OWNER)) as never
        );
        await getStorylinePath({ chapterId: n, viewer: { id: 99 }, browsingLevel: PG });
        return r.$queryRaw.mock.calls.length;
      };
      const few = await queriesFor(2);
      expect(await queriesFor(50)).toBe(few);
      // The path, the main route's chapter ids, and the first images.
      expect(few).toBe(3);
    });

    it('gives the ways on their first images, none to a tombstone', async () => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10 } as never);
      r.storylineCollaborator.findMany.mockResolvedValue([] as never);
      r.storylineChapterEdge.findFirst.mockResolvedValue(null as never);
      const child = (id: number, overrides: Record<string, unknown> = {}) => ({
        canon: false,
        chapter: {
          id,
          depth: 1,
          userId: STRANGER,
          createdAt: new Date('2026-10-02'),
          removedAt: null,
          post: chapterPost(id + 100, STRANGER, overrides),
          _count: { parents: 1 },
        },
      });
      r.storylineChapterEdge.findMany.mockResolvedValue([
        child(11),
        child(12, { publishedAt: null }),
      ] as never);
      answerRaw([]);
      const children = await getStorylineChildren({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: PG,
        readersByChapterId: new Map(),
      });
      expect(children.map((c) => [c.chapterId, c.firstImage?.id ?? null])).toEqual([
        [11, 1111],
        [12, null],
      ]);
      expect(rawCalls().filter((call) => isFirstImageRead(call.text))).toHaveLength(1);
    });

    it('reads no hidden lists and no images when no chapter is shown', async () => {
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 0 } as never);
      answerRaw([{ id: 1, postId: null, depth: 0, removedAt: null, parentIds: [] }]);
      r.post.findMany.mockResolvedValue([] as never);
      const { chapters } = await getStorylinePath({
        chapterId: 1,
        viewer: { id: 99 },
        browsingLevel: PG,
      });
      expect(chapters[0].firstImage).toBeNull();
      expect(getAllHiddenForUser).not.toHaveBeenCalled();
      expect(rawCalls().filter((call) => isFirstImageRead(call.text))).toHaveLength(0);
    });

    it('applies the image gate to first images: level, ceiling, hidden images and tags', async () => {
      getAllHiddenForUser.mockResolvedValue({
        hiddenImages: [{ id: 77, hidden: true }],
        hiddenTags: [{ id: 5, hidden: true }],
      });
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 0 } as never);
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }]);
      r.post.findMany.mockResolvedValue([chapterPost(101, OWNER)] as never);
      await getStorylinePath({ chapterId: 1, viewer: { id: 99 }, browsingLevel: PG });
      const read = rawCalls().find((call) => isFirstImageRead(call.text))!;
      expect(read.text).toContain(
        `WHERE i."postId" = ANY(?::int[]) AND i.ingestion = 'Scanned' AND i."tosViolation" = false AND i."needsReview" IS NULL`
      );
      expect(read.text).toContain('AND i.minor = false AND i.poi = false');
      expect(read.text).toContain('AND i."nsfwLevel" <> 0');
      expect(read.text).toContain(
        'AND (i."nsfwLevel" & ~((CASE WHEN st."minorByScan" THEN LEAST(st."maxNsfwLevel", ?) ELSE st."maxNsfwLevel" END) * 2 - 1)) = 0'
      );
      expect(read.values).toEqual([[101], 99, PG, NsfwLevel.PG13, [77], [5], 99]);
      expect(getAllHiddenForUser).toHaveBeenCalledWith({ userId: 99 });
    });
  });

  it("applies the reader's image gate to the map's chapters too", async () => {
    getAllHiddenForUser.mockResolvedValue({
      hiddenImages: [{ id: 77, hidden: true }],
      hiddenTags: [{ id: 5, hidden: true }],
    });
    r.storylineChapter.findMany.mockResolvedValue([
      { id: 1, depth: 0, removedAt: null, post: chapterPost(101, OWNER) },
      {
        id: 2,
        depth: 1,
        removedAt: null,
        post: chapterPost(102, STRANGER, { tosViolation: true }),
      },
    ] as never);
    r.storylineChapterEdge.findMany.mockResolvedValue([
      { chapterId: 2, parentChapterId: 1, canon: true },
    ] as never);
    answerRaw([]);
    const { chapters } = await getStorylineGraph({ id: 10, viewer: { id: 99 }, browsingLevel: PG });
    expect(chapters.map((c) => [c.chapterId, c.tombstone, c.firstImage?.id ?? null])).toEqual([
      [1, null, 1101],
      [2, 'removed', null],
    ]);
    const reads = rawCalls().filter((call) => isFirstImageRead(call.text));
    expect(reads).toHaveLength(1);
    // The same bound values as the path's read: posts, the reader, their level, hidden lists.
    expect(reads[0].values).toEqual([[101], 99, PG, NsfwLevel.PG13, [77], [5], 99]);
    // One row past the cap, so the read can tell a full map from a cut one without reading more.
    expect(r.storylineChapter.findMany.mock.calls[0][0]).toMatchObject({
      take: STORYLINE_GRAPH_LIMIT + 1,
    });
  });

  it("flags the map's contributor chapters as via a placement, tombstones included", async () => {
    r.storylineChapter.findMany.mockResolvedValue([
      { id: 1, depth: 0, removedAt: null, placementId: null, post: chapterPost(101, OWNER) },
      { id: 2, depth: 1, removedAt: null, placementId: 7, post: chapterPost(102, STRANGER) },
      {
        id: 3,
        depth: 1,
        removedAt: null,
        placementId: 8,
        post: chapterPost(103, STRANGER, { tosViolation: true }),
      },
    ] as never);
    r.storylineChapterEdge.findMany.mockResolvedValue([] as never);
    answerRaw([]);
    const { chapters } = await getStorylineGraph({ id: 10, viewer: { id: 99 }, browsingLevel: PG });
    expect(chapters.map((c) => [c.chapterId, c.tombstone, c.viaPlacement])).toEqual([
      [1, null, false],
      [2, null, true],
      [3, 'removed', true],
    ]);
    expect(JSON.stringify(chapters)).not.toContain('placementId');
  });

  describe('the storyline page', () => {
    const page = (viewer: { id: number; isModerator?: boolean } | undefined) =>
      getStoryline({ id: 10, viewer, browsingLevel: PG });
    const withPicks = (picks: { coverImageId?: number | null; heroImageId?: number | null }) =>
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow(),
        coverImageId: null,
        heroImageId: null,
        heroImagePosition: 30,
        collaborators: [],
        ...picks,
      } as never);

    beforeEach(() => {
      withPicks({});
      r.post.findMany.mockResolvedValue([chapterPost(101, OWNER)] as never);
    });

    beforeEach(() => getBlockedPairIds.mockResolvedValue([BLOCKED]));

    it.each([
      ['the banner pick', { heroImageId: 7, coverImageId: 8 }, [picked(7), picked(8)], 7],
      [
        'the cover pick when the banner is hidden',
        { heroImageId: 7, coverImageId: 8 },
        [picked(8)],
        8,
      ],
      ['the cover pick when there is no banner', { coverImageId: 8 }, [picked(8)], 8],
      [
        "chapter 1's first image when neither is visible",
        { heroImageId: 7, coverImageId: 8 },
        [],
        1101,
      ],
      [
        "chapter 1's first image when the pick's chapter is a tombstone to the reader",
        { heroImageId: 7 },
        [picked(7, { removedAt: new Date(), postUserId: STRANGER })],
        1101,
      ],
      [
        "chapter 1's first image when the pick's chapter was taken down",
        { heroImageId: 7 },
        [picked(7, { postTosViolation: true })],
        1101,
      ],
      [
        "chapter 1's first image when the pick's chapter is outside the reader's level",
        { heroImageId: 7 },
        [picked(7, { postNsfwLevel: NsfwLevel.R })],
        1101,
      ],
      [
        "chapter 1's first image when the pick's author is banned",
        { heroImageId: 7 },
        [picked(7, { bannedAt: new Date() })],
        1101,
      ],
      [
        "chapter 1's first image when the pick's author is deleted",
        { heroImageId: 7 },
        [picked(7, { deletedAt: new Date() })],
        1101,
      ],
      [
        "chapter 1's first image when the reader blocked the pick's author",
        { heroImageId: 7 },
        [picked(7, { postUserId: BLOCKED })],
        1101,
      ],
      [
        "chapter 1's first image when the pick is another storyline's",
        { heroImageId: 7 },
        [picked(7, { storylineId: 11 })],
        1101,
      ],
    ])('shows %s as the banner', async (_n, picks, chosenRows, heroId) => {
      withPicks(picks);
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }], chosenRows);
      const storyline = await page({ id: 99 });
      expect(storyline.heroImage?.id).toBe(heroId);
      // Only the banner pick (7 in every case) is shown as a banner; any fallback is a portrait.
      expect(storyline.heroIsBanner).toBe(heroId === 7);
      expect(storyline.heroImagePosition).toBe(30);
      expect(rawCalls().filter((call) => isChosenImageRead(call.text))).toHaveLength(1);
    });

    it('shows an uploaded pick (in no post) the gate passes, as banner and cover', async () => {
      withPicks({ heroImageId: 30, coverImageId: 30 });
      answerRaw(
        [{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }],
        [picked(30, { chapterId: null, postId: null })]
      );
      const storyline = await page({ id: 99 });
      expect(storyline.heroImage?.id).toBe(30);
      expect(storyline.heroIsBanner).toBe(true);
      expect(storyline.coverImage?.id).toBe(30);
    });

    it.each([
      ['by a moderator', { userId: MODERATOR, uploaderIsModerator: true }, 30],
      ['by someone else', { userId: STRANGER }, 1101],
      ['by its owner, now banned', { uploaderBannedAt: new Date() }, 1101],
      ['by its owner, now deleted', { uploaderDeletedAt: new Date() }, 1101],
    ])('an image in no post %s is shown as the pick: %s', async (_n, extra, heroId) => {
      withPicks({ heroImageId: 30 });
      answerRaw(
        [{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }],
        [picked(30, { chapterId: null, postId: null, ...extra })]
      );
      expect((await page({ id: 99 })).heroImage?.id).toBe(heroId);
    });

    it('never shows a pick from a post that is no chapter of it', async () => {
      withPicks({ heroImageId: 31 });
      answerRaw(
        [{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }],
        [picked(31, { chapterId: null })]
      );
      expect((await page({ id: 99 })).heroImage?.id).toBe(1101);
    });

    it('tells the owner a pick is not showing yet, and readers nothing', async () => {
      withPicks({ heroImageId: 30, coverImageId: 30 });
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }], []);
      expect(await page({ id: OWNER })).toMatchObject({
        coverPickHidden: true,
        heroPickHidden: true,
      });
      expect(await page({ id: 99 })).toMatchObject({
        coverPickHidden: false,
        heroPickHidden: false,
      });
    });

    it('shows a pick from a chapter only its author or a moderator may see, to them', async () => {
      withPicks({ heroImageId: 7 });
      const unpublished = [picked(7, { postUserId: STRANGER, publishedAt: null })];
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }], unpublished);
      expect((await page({ id: STRANGER })).heroImage?.id).toBe(7);
      expect((await page({ id: MODERATOR, isModerator: true })).heroImage?.id).toBe(7);
      expect((await page({ id: 99 })).heroImage?.id).toBe(1101);
    });

    it('has no banner when chapter 1 is a tombstone and nothing is picked', async () => {
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }]);
      r.post.findMany.mockResolvedValue([chapterPost(101, OWNER, { tosViolation: true })] as never);
      const storyline = await page({ id: 99 });
      expect(storyline.heroImage).toBeNull();
      expect(rawCalls().filter((call) => isChosenImageRead(call.text))).toHaveLength(0);
    });

    it("reads the picks with the reader's hidden images and tags, read once", async () => {
      getAllHiddenForUser.mockResolvedValue({
        hiddenImages: [{ id: 77, hidden: true }],
        hiddenTags: [{ id: 5, hidden: true }],
      });
      withPicks({ heroImageId: 7, coverImageId: 8 });
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }]);
      await page({ id: 99 });
      const read = rawCalls().find((call) => isChosenImageRead(call.text))!;
      expect(read.values).toEqual([[10, 10], [7, 8], 99, PG, NsfwLevel.PG13, [77], [5], 99]);
      // The hidden lists are read once for the picks and the main route together.
      expect(getAllHiddenForUser).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the cover pick', { heroImageId: 7, coverImageId: 8 }, [picked(7), picked(8)], 8],
      ["chapter 1's first image when the cover pick is hidden", { coverImageId: 8 }, [], 1101],
      [
        "chapter 1's first image, not the banner pick, when there is no cover pick",
        { heroImageId: 7 },
        [picked(7)],
        1101,
      ],
    ])('gives the card picture as the feed does: %s', async (_n, picks, chosenRows, coverId) => {
      withPicks(picks);
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }], chosenRows);
      expect((await page({ id: 99 })).coverImage?.id).toBe(coverId);
    });

    it('counts the chapters each credited author has that the reader is shown', async () => {
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow(),
        coverImageId: null,
        heroImageId: null,
        heroImagePosition: 50,
        collaborators: [
          { acceptedAt: new Date(), user: { id: COLLABORATOR, username: 'c', ...notBanned } },
        ],
      } as never);
      r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const { text } = composed([strings, ...values]);
        if (text.includes('c."userId" = ANY('))
          return Promise.resolve([
            { userId: OWNER, chapterCount: 4 },
            { userId: COLLABORATOR, chapterCount: 2 },
          ]);
        if (text.includes('GROUP BY c."userId" ORDER BY'))
          return Promise.resolve([{ userId: STRANGER, chapterCount: 3 }]);
        return Promise.resolve([]);
      }) as never);
      r.user.findMany.mockResolvedValue([{ id: STRANGER, username: 's', ...notBanned }] as never);

      const { contributors } = await page({ id: 99 });
      expect(contributors.map((c) => [c.user.id, c.role, c.chapterCount])).toEqual([
        [OWNER, 'creator', 4],
        [COLLABORATOR, 'endorsed', 2],
        [STRANGER, 'contributor', 3],
      ]);
      const castRead = rawCalls().find((call) => call.text.includes('c."userId" = ANY('))!;
      const authorsRead = rawCalls().find((call) =>
        call.text.includes('GROUP BY c."userId" ORDER BY')
      )!;
      // Both counts use the credits' own rule for a shown chapter, word for word.
      const shownRule = (text: string) =>
        text.slice(text.indexOf('c."removedAt" IS NULL'), text.indexOf('GROUP BY')).trim();
      expect(castRead.text.trim()).toBe(
        `SELECT c."userId", COUNT(*)::int AS "chapterCount" FROM "StorylineChapter" c JOIN "Post" p ON p.id = c."postId" WHERE c."storylineId" = ? AND c."userId" = ANY(?::int[]) AND ${shownRule(
          authorsRead.text
        )} GROUP BY c."userId"`
          .replace(/\s+/g, ' ')
          .trim()
      );
      expect(shownRule(authorsRead.text)).toContain('AND p."tosViolation" = false');
      expect(castRead.values.slice(0, 2)).toEqual([10, [OWNER, COLLABORATOR]]);
      expect(authorsRead.text).toContain(
        'SELECT c."userId", COUNT(*)::int AS "chapterCount" FROM "StorylineChapter" c'
      );
    });

    it('counts no chapters for an author with none the reader is shown', async () => {
      answerRaw([]);
      const { contributors } = await page({ id: 99 });
      expect(contributors).toEqual([expect.objectContaining({ role: 'creator', chapterCount: 0 })]);
    });

    it('gives the raw picks to the owner and moderators only', async () => {
      withPicks({ heroImageId: 7, coverImageId: 8 });
      answerRaw([{ id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] }]);
      for (const viewer of [{ id: OWNER }, { id: MODERATOR, isModerator: true }])
        await expect(page(viewer)).resolves.toMatchObject({ coverImageId: 8, heroImageId: 7 });
      for (const viewer of [{ id: 99 }, undefined])
        await expect(page(viewer)).resolves.toMatchObject({
          coverImageId: null,
          heroImageId: null,
        });
    });

    it('credits the owner, collaborators, contributors and route authors with their cosmetics', async () => {
      const cast = (id: number) => ({
        id,
        username: `u${id}`,
        image: null,
        profilePicture: null,
        cosmetics: [{ data: null, cosmetic: { id: id * 10 } }],
        ...notBanned,
      });
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow({ user: cast(OWNER) }),
        coverImageId: null,
        heroImageId: null,
        heroImagePosition: 50,
        collaborators: [{ acceptedAt: new Date(), user: cast(COLLABORATOR) }],
      } as never);
      r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = sqlOfRaw(strings, values);
        if (sql.includes('GROUP BY c."userId"')) return Promise.resolve([{ userId: STRANGER }]);
        if (sql.includes('WITH RECURSIVE main'))
          return Promise.resolve([
            { id: 1, postId: 101, depth: 0, removedAt: null, parentIds: [] },
          ]);
        return Promise.resolve([]);
      }) as never);
      r.user.findMany.mockResolvedValue([cast(STRANGER)] as never);
      r.post.findMany.mockResolvedValue([
        { ...chapterPost(101, OWNER), user: cast(OWNER) },
      ] as never);

      const storyline = await page({ id: 99 });
      const { bannedAt: _b, deletedAt: _d, ...shown } = cast(OWNER);
      expect(storyline.user).toEqual(shown);
      expect(storyline.contributors.map((c) => c.user.cosmetics[0].cosmetic.id)).toEqual([
        OWNER * 10,
        COLLABORATOR * 10,
        STRANGER * 10,
      ]);
      expect(storyline.mainPath[0].post?.user).toEqual(shown);
      for (const c of storyline.contributors) expect(c.user).not.toHaveProperty('bannedAt');

      const cosmeticsSelect = expect.objectContaining({
        cosmetics: expect.objectContaining({
          where: { equippedAt: { not: null }, equippedToId: null },
        }),
        bannedAt: true,
        deletedAt: true,
        profilePicture: expect.anything(),
      });
      expect(r.storyline.findUnique.mock.calls[0][0]).toMatchObject({
        select: {
          user: { select: cosmeticsSelect },
          collaborators: { select: { user: { select: cosmeticsSelect } } },
        },
      });
      expect(r.user.findMany.mock.calls[0][0]).toMatchObject({ select: cosmeticsSelect });
      expect(r.post.findMany.mock.calls[0][0]).toMatchObject({
        select: { user: { select: cosmeticsSelect } },
      });
    });
  });

  describe('feed cards', () => {
    const feedRow = (id: number, overrides: Record<string, unknown> = {}) => ({
      id,
      title: `s${id}`,
      status: 'Ongoing',
      userId: OWNER,
      username: 'owner',
      bannedAt: null,
      deletedAt: null,
      maxNsfwLevel: NsfwLevel.R,
      whoCanContinue: 'Anyone',
      isCollaborator: false,
      rootPostId: 500 + id,
      rootNsfwLevel: PG,
      rootPublishedAt: new Date('2026-10-01'),
      rootTosViolation: false,
      storylineMode: null,
      storylinePrice: null,
      userMode: null,
      userPrice: null,
      chapterCount: 1,
      contributorCount: 1,
      createdAt: new Date('2026-10-01'),
      coverImageId: null,
      ...overrides,
    });
    const answerFeed = (rows: unknown[], chosenRows: unknown[] = []) =>
      r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
        const { text, values: bound } = composed([strings, ...values]);
        if (isFirstImageRead(text))
          return Promise.resolve(
            (bound[0] as number[]).map((postId) => ({ postId, ...image(postId + 1000) }))
          );
        if (isChosenImageRead(text)) return Promise.resolve(chosenRows);
        return Promise.resolve(rows);
      }) as never);
    const feed = (viewer: { id: number } | undefined = { id: 99 }) =>
      getStorylinesInfinite({
        filter: 'all',
        sort: 'newest',
        limit: 24,
        viewer,
        browsingLevel: PG,
      });

    beforeEach(() => placementPriceRanges.mockResolvedValue(new Map()));

    it("covers a card with the owner's pick when the reader may see it, else chapter 1's first image", async () => {
      answerFeed(
        [
          feedRow(10, { coverImageId: 7 }),
          feedRow(11, { coverImageId: 8 }),
          feedRow(12, { coverImageId: 9 }),
        ],
        [picked(7, { storylineId: 10 }), picked(9, { storylineId: 10 })]
      );
      const { items } = await feed();
      expect(items.map((item) => item.coverImage?.id)).toEqual([7, 1511, 1512]);
      expect(items[0].coverImage).toEqual(image(7));
      expect(items[0]).not.toHaveProperty('coverImageId');
      // Three reads for the page, whatever its size: the page, first images, picks.
      expect(r.$queryRaw).toHaveBeenCalledTimes(3);
      expect(
        rawCalls()
          .find((call) => isChosenImageRead(call.text))!
          .values.slice(0, 2)
      ).toEqual([
        [10, 11, 12],
        [7, 8, 9],
      ]);
      expect(rawCalls()[0].text).toContain('st."createdAt", st."coverImageId" FROM "Storyline" st');
    });

    it('never covers a card with a pick from a chapter the reader is shown as a tombstone', async () => {
      answerFeed(
        [feedRow(10, { coverImageId: 7 })],
        [picked(7, { postUserId: STRANGER, publishedAt: null })]
      );
      const [item] = (await feed()).items;
      expect(item.coverImage?.id).toBe(1510);
    });

    it('reads no picks when no card has one', async () => {
      answerFeed([feedRow(10)]);
      await feed();
      expect(rawCalls().filter((call) => isChosenImageRead(call.text))).toHaveLength(0);
      expect(r.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("gives each card its owner's avatar and cosmetics, in one read for the page", async () => {
      answerFeed([feedRow(10), feedRow(11), feedRow(12, { userId: COLLABORATOR, username: 'c' })]);
      r.user.findMany.mockResolvedValue([
        {
          id: OWNER,
          username: 'owner',
          image: 'a.png',
          profilePicture: null,
          cosmetics: [],
          ...notBanned,
        },
      ] as never);
      const { items } = await feed();
      expect(r.user.findMany).toHaveBeenCalledTimes(1);
      expect(r.user.findMany.mock.calls[0][0]).toMatchObject({
        where: { id: { in: [OWNER, COLLABORATOR] } },
        select: expect.objectContaining({
          cosmetics: expect.anything(),
          profilePicture: expect.anything(),
        }),
      });
      expect(items[0].user).toEqual({
        id: OWNER,
        username: 'owner',
        image: 'a.png',
        profilePicture: null,
        cosmetics: [],
      });
      // An owner the read did not return still gets their name.
      expect(items[2].user).toEqual({ id: COLLABORATOR, username: 'c' });
    });
  });
});

describe('title moderation', () => {
  const { PG, PG13, R, X } = NsfwLevel;
  const PG_READER = PG | PG13;

  describe("the title's rating hides the story from readers below it", () => {
    const titled = (over: Record<string, unknown>) =>
      storylineRow({ collaborators: [], coverImageId: null, heroImageId: null, ...over });

    // Chapter 1 is PG throughout, so each hide here comes from the title alone.
    it.each([
      ['a scanned R title', { nsfwLevel: R }, true],
      ['a moderator rating of R over a PG scan', { nsfwLevel: PG, moderatorNsfwLevel: R }, true],
      [
        'a moderator rating of PG13 over an X scan',
        { nsfwLevel: X, moderatorNsfwLevel: PG13 },
        false,
      ],
      ['a title not yet scanned', { nsfwLevel: 0 }, false],
      ['a PG title', { nsfwLevel: PG }, false],
    ])('getStoryline: %s -> hidden %s', async (_name, over, hidden) => {
      r.storyline.findUnique.mockResolvedValue(titled(over) as never);
      const read = getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG_READER });
      if (hidden) await expect(read).rejects.toMatchObject({ code: 'NOT_FOUND' });
      else await expect(read).resolves.toMatchObject({ id: 10 });
      // A reader who browses at R is shown it either way, as are the owner and moderators.
      await expect(
        getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG_READER | R })
      ).resolves.toMatchObject({ id: 10 });
      for (const viewer of [{ id: OWNER }, { id: MODERATOR, isModerator: true }])
        await expect(
          getStoryline({ id: 10, viewer, browsingLevel: PG_READER })
        ).resolves.toMatchObject({ id: 10 });
    });

    // A post's level is a mask of its images' levels. Comparing it with the title as a number
    // would keep a PG image's flag and let a PG reader past an R title.
    it.each([
      ['an R title on a chapter 1 with PG and X images', PG | X, R, true, X],
      ['a PG title on an X chapter 1', X, PG, true, X],
      ['an X title on an R chapter 1', R, X, true, X],
      ['an R title on a chapter 1 with PG and R images', PG | R, R, true, R],
      ['a PG title on a chapter 1 with PG and X images', PG | X, PG, false, X],
    ])('getStoryline: %s -> hidden from PG %s', async (_n, chapterLevel, title, hidden, seenAt) => {
      r.storyline.findUnique.mockResolvedValue(
        titled({
          maxNsfwLevel: X,
          nsfwLevel: title,
          chapters: [
            {
              id: 1,
              postId: 101,
              removedAt: null,
              post: {
                nsfwLevel: chapterLevel,
                publishedAt: new Date(0),
                tosViolation: false,
                user: { bannedAt: null, deletedAt: null },
              },
            },
          ],
        }) as never
      );
      const read = getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG_READER });
      if (hidden) await expect(read).rejects.toMatchObject({ code: 'NOT_FOUND' });
      else await expect(read).resolves.toMatchObject({ id: 10 });
      await expect(
        getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: seenAt })
      ).resolves.toMatchObject({ id: 10 });
    });

    // The db mock returns the fixture whatever is selected; without these the real read would
    // leave the title's rating out and the gate would judge on nothing.
    it('reads the title rating wherever the gate runs', async () => {
      const levels = { nsfwLevel: true, moderatorNsfwLevel: true };
      r.storyline.findUnique.mockResolvedValue(titled({}) as never);
      await getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: PG_READER });
      expect(r.storyline.findUnique.mock.calls[0][0]).toMatchObject({ select: levels });
      r.storylineChapter.findMany.mockResolvedValue([] as never);
      await getStorylinesForPosts({ postIds: [1], viewer: undefined, browsingLevel: PG });
      expect(r.storylineChapter.findMany.mock.calls[0][0]).toMatchObject({
        select: { storyline: { select: levels } },
      });
    });

    it('getStorylinesForPosts: leaves out a story whose title is above the reader', async () => {
      const chapter = (postId: number, storyline: Record<string, unknown>) => ({
        id: postId + 1000,
        postId,
        depth: 1,
        removedAt: null,
        post: { nsfwLevel: PG, userId: AUTHOR_OF_POSTS, tosViolation: false, user: notBanned },
        storyline: {
          id: postId,
          title: `s${postId}`,
          userId: OWNER,
          maxNsfwLevel: X,
          tosViolation: false,
          nsfwLevel: 0,
          moderatorNsfwLevel: null,
          user: notBanned,
          chapters: [
            {
              removedAt: null,
              post: {
                nsfwLevel: PG,
                publishedAt: new Date(0),
                tosViolation: false,
                user: { bannedAt: null, deletedAt: null },
              },
            },
          ],
          ...storyline,
        },
      });
      r.storylineChapter.findMany.mockResolvedValue([
        chapter(1, { nsfwLevel: PG }),
        chapter(2, { nsfwLevel: R }),
        chapter(3, { nsfwLevel: X, moderatorNsfwLevel: PG }),
      ] as never);
      const result = await getStorylinesForPosts({
        postIds: [1, 2, 3],
        viewer: { id: STRANGER },
        browsingLevel: PG_READER,
      });
      expect(Object.keys(result).map(Number)).toEqual([1, 3]);
    });

    // The CASE itself is raiseNsfwLevelText's, pinned in its own package
    // (packages/civitai-shared/src/__tests__/rated-entity-sql.test.ts); this pins what it is
    // applied to.
    it('getStorylinesInfinite: the level filter raises chapter 1 to the title', async () => {
      await getStorylinesInfinite({
        filter: 'all',
        sort: 'newest',
        limit: 20,
        viewer: { id: STRANGER },
        browsingLevel: PG_READER,
      });
      const [strings, ...values] = r.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
        ...unknown[]
      ];
      const { sql, values: bound } = Prisma.sql(strings, ...(values as Prisma.Sql[]));
      const text = sql.replace(/\s+/g, ' ');
      const level =
        `OR ((SELECT ${raiseNsfwLevelText('lv.l', 'lv.f')} ` +
        `FROM (SELECT COALESCE(NULLIF(NULLIF(rp."nsfwLevel", 0), ?), st."maxNsfwLevel") AS l, ` +
        `COALESCE(st."moderatorNsfwLevel", st."nsfwLevel") AS f) lv) & ?::int) <> 0)`;
      expect(text).toContain(level);
      // A wholly Blocked chapter 1 falls back to the ceiling, as an unrated one does.
      const at = text.slice(0, text.indexOf(level) + level.indexOf('?')).split('?').length - 1;
      expect(bound[at]).toBe(NsfwLevel.Blocked);
    });
  });

  describe('scanning the title', () => {
    it('scans a new storyline once it is created', async () => {
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER }) as never);
      w.storyline.create.mockResolvedValue({ id: 10 } as never);
      w.storylineChapter.create.mockResolvedValue({ id: 20 } as never);
      await createStoryline({ postId: 500, title: 't', maxNsfwLevel: R, userId: OWNER });
      expect(scanEntityInBackground.mock.calls).toEqual([
        [{ entityType: 'Storyline', entityId: 10 }],
      ]);
    });

    it('does not scan a storyline that was never created', async () => {
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: STRANGER }) as never);
      await expect(
        createStoryline({ postId: 500, title: 't', maxNsfwLevel: R, userId: OWNER })
      ).rejects.toThrow();
      expect(scanEntityInBackground).not.toHaveBeenCalled();
    });

    it('rescans when the title changes, and only then', async () => {
      w.storyline.findUnique.mockResolvedValue(storylineRow({ title: 'Old' }) as never);
      w.storyline.update.mockResolvedValue(storylineRow() as never);
      await updateStoryline({ id: 10, title: 'Old', userId: OWNER });
      await updateStoryline({ id: 10, status: 'Complete', userId: OWNER });
      expect(scanEntityInBackground).not.toHaveBeenCalled();
      await updateStoryline({ id: 10, title: 'New', userId: OWNER });
      expect(scanEntityInBackground.mock.calls).toEqual([
        [{ entityType: 'Storyline', entityId: 10 }],
      ]);
    });
  });

  describe('moderateStorylineTitle', () => {
    const lift = { reviewedTitle: 'Bad' };
    beforeEach(() => {
      w.storyline.findUnique.mockResolvedValue({
        tosViolationByScan: true,
        title: 'Bad',
        userId: OWNER,
      } as never);
      w.storyline.updateMany.mockResolvedValue({ count: 1 } as never);
      w.storyline.findUniqueOrThrow.mockResolvedValue({ id: 10 } as never);
    });

    // Any later read of the title answers 'Worse' here: the hash must be of the text reviewed,
    // which the update's WHERE re-checks, not of whatever a second read returns.
    it("lifts the scan's takedown and records the hash of the title reviewed", async () => {
      w.storyline.findMany.mockResolvedValue([{ id: 10, userId: OWNER, title: 'Worse' }] as never);
      await moderateStorylineTitle({ id: 10, liftScanTakedown: lift });
      const reviewed = textScanTextHash(storylineTextScanSubject({ userId: OWNER, title: 'Bad' }));
      // Two writes, one per state of the moderator's flag: the storyline comes back up only when
      // no moderator holds a takedown of their own (see storyline-takedown.test.ts).
      const data = { moderatorNsfwLevel: undefined, scanFlagLiftedTextHash: reviewed };
      expect(w.storyline.updateMany.mock.calls).toEqual([
        [
          {
            where: {
              title: 'Bad',
              id: 10,
              tosViolationByScan: true,
              tosViolationByModerator: false,
            },
            data: { ...data, tosViolation: false, tosViolationByScan: false },
          },
        ],
        [
          {
            where: {
              title: 'Bad',
              id: 10,
              tosViolationByScan: true,
              tosViolationByModerator: true,
            },
            data: { ...data, tosViolationByScan: false },
          },
        ],
      ]);
    });

    it("refuses to lift a moderator's takedown", async () => {
      w.storyline.findUnique.mockResolvedValue({
        tosViolationByScan: false,
        title: 'Bad',
      } as never);
      await expect(
        moderateStorylineTitle({ id: 10, liftScanTakedown: lift })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.storyline.updateMany).not.toHaveBeenCalled();
    });

    // The owner edited the title after the moderator read it: the new one was never reviewed.
    it('refuses to lift for a title other than the one reviewed', async () => {
      w.storyline.findUnique.mockResolvedValue({
        tosViolationByScan: true,
        title: 'Worse',
      } as never);
      await expect(
        moderateStorylineTitle({ id: 10, liftScanTakedown: lift })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.storyline.updateMany).not.toHaveBeenCalled();
    });

    it('refuses when the takedown or the title changed in between', async () => {
      w.storyline.updateMany.mockResolvedValue({ count: 0 } as never);
      await expect(
        moderateStorylineTitle({ id: 10, liftScanTakedown: lift })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    // Set beside a scan takedown, so leaving it in place is something the call could get wrong.
    it.each([
      // Below R: an R rating can also take down a minor-flagged title, a case of its own below.
      ['sets', NsfwLevel.PG13],
      ['hands back to the scan', null],
    ])('%s the rating without touching a takedown', async (_name, level) => {
      await moderateStorylineTitle({ id: 10, moderatorNsfwLevel: level });
      expect(w.storyline.updateMany.mock.calls).toEqual([
        [{ where: { id: 10 }, data: { moderatorNsfwLevel: level } }],
      ]);
    });

    it('refuses a rating that is not one level', async () => {
      await expect(
        moderateStorylineTitle({ id: 10, moderatorNsfwLevel: PG | R })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(w.storyline.updateMany).not.toHaveBeenCalled();
    });

    it('is not found for a storyline that does not exist', async () => {
      w.storyline.findUnique.mockResolvedValue(null as never);
      await expect(moderateStorylineTitle({ id: 10, moderatorNsfwLevel: R })).rejects.toMatchObject(
        { code: 'NOT_FOUND' }
      );
    });
  });
});

// While the title scan holds a storyline as about a minor, every read and write below holds
// chapters to `storylineCeiling`. Each case runs once with the flag and once without it, the
// control: an R chapter that is fine under the owner's ceiling alone.
describe('a storyline the title scan holds as about a minor', () => {
  const R = NsfwLevel.R;
  const ALL = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X;

  describe.each([
    ['held as about a minor', true],
    ['not held (control)', false],
  ])('%s', (_name, minorByScan) => {
    it('the owner adding an R chapter directly', async () => {
      w.storylineChapter.findUnique.mockResolvedValue({
        id: 20,
        storylineId: 10,
        depth: 0,
        removedAt: null,
        storyline: { userId: OWNER, maxNsfwLevel: NsfwLevel.X, minorByScan, tosViolation: false },
      } as never);
      w.storylineChapter.create.mockResolvedValue({ id: 30 } as never);
      w.post.findUnique.mockResolvedValue(publishedPost({ userId: OWNER, nsfwLevel: R }) as never);
      const added = addOwnerChapter({ parentChapterId: 20, postId: 600, userId: OWNER });
      if (minorByScan) await expect(added).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      else await expect(added).resolves.toEqual({ chapterId: 30 });
    });

    it('the owner choosing an R image as the cover', async () => {
      w.storyline.findUnique.mockResolvedValue(
        storylineRow({
          maxNsfwLevel: NsfwLevel.X,
          minorByScan,
          coverImageId: null,
          heroImageId: null,
        }) as never
      );
      w.storylineCollaborator.findMany.mockResolvedValue([] as never);
      w.storyline.update.mockResolvedValue({} as never);
      w.image.findMany.mockResolvedValue([
        {
          id: 70,
          nsfwLevel: R,
          minor: false,
          poi: false,
          post: { storylineChapter: { storylineId: 10, userId: OWNER, removedAt: null } },
        },
      ] as never);
      const picked = updateStoryline({ id: 10, userId: OWNER, coverImageId: 70 });
      if (minorByScan) await expect(picked).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      else await expect(picked).resolves.toBeDefined();
    });

    it("an R chapter's image pill, for a reader who browses at R", async () => {
      getBlockedPairIds.mockResolvedValue([]);
      r.storylineChapter.findMany.mockResolvedValue([
        {
          id: 1001,
          postId: 1,
          depth: 1,
          post: { nsfwLevel: R, userId: AUTHOR_OF_POSTS, tosViolation: false, user: notBanned },
          storyline: {
            id: 10,
            title: 'A story',
            userId: OWNER,
            maxNsfwLevel: NsfwLevel.X,
            minorByScan,
            tosViolation: false,
            nsfwLevel: 0,
            moderatorNsfwLevel: null,
            user: notBanned,
            chapters: [
              {
                removedAt: null,
                post: {
                  nsfwLevel: NsfwLevel.PG,
                  publishedAt: new Date(0),
                  tosViolation: false,
                  user: { bannedAt: null, deletedAt: null },
                },
              },
            ],
          },
        },
      ] as never);
      const pills = await getStorylinesForPosts({
        postIds: [1],
        viewer: { id: STRANGER },
        browsingLevel: ALL,
      });
      expect(Object.keys(pills)).toEqual(minorByScan ? [] : ['1']);
    });

    it('the ceiling the page and a feed card report', async () => {
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow({ maxNsfwLevel: NsfwLevel.X, minorByScan }),
        collaborators: [],
      } as never);
      r.$queryRaw.mockResolvedValue([] as never);
      r.user.findMany.mockResolvedValue([] as never);
      r.post.findMany.mockResolvedValue([] as never);
      const ceiling = minorByScan ? NsfwLevel.PG13 : NsfwLevel.X;

      const asOwner = await getStoryline({ id: 10, viewer: { id: OWNER }, browsingLevel: ALL });
      expect(asOwner).toMatchObject({ maxNsfwLevel: ceiling, ownerMaxNsfwLevel: NsfwLevel.X });
      for (const field of ['minorByScan', 'nsfwLevel', 'moderatorNsfwLevel'])
        expect(asOwner).not.toHaveProperty(field);
      const asReader = await getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: ALL });
      expect(asReader).toMatchObject({ maxNsfwLevel: ceiling, ownerMaxNsfwLevel: null });

      // The cast counts only chapters under the ceiling: its mask is a bound value.
      const castMask = ceiling * 2 - 1;
      const counted = r.$queryRaw.mock.calls.find(([s]) =>
        (s as unknown as string[]).join('?').includes('COUNT(DISTINCT')
      );
      const [strings, ...values] = counted as unknown as [TemplateStringsArray, ...unknown[]];
      expect(Prisma.sql(strings, ...(values as Prisma.Sql[])).values).toContain(castMask);

      r.$queryRaw.mockReset().mockResolvedValue([
        {
          id: 10,
          title: 'A story',
          status: 'Ongoing',
          userId: OWNER,
          username: 'owner',
          maxNsfwLevel: NsfwLevel.X,
          minorByScan,
          whoCanContinue: 'Anyone',
          rootPostId: 101,
          chapterCount: 1,
          contributorCount: 1,
          createdAt: new Date('2026-10-01'),
        },
      ] as never);
      const page = await getStorylinesInfinite({
        filter: 'all',
        sort: 'newest',
        limit: 2,
        viewer: undefined,
        browsingLevel: ALL,
      });
      expect(page.items[0]).toMatchObject({ maxNsfwLevel: ceiling });
      expect(page.items[0]).not.toHaveProperty('minorByScan');
    });

    it("an R chapter on the page's reading route", async () => {
      r.storyline.findUnique.mockResolvedValue({
        ...storylineRow({ maxNsfwLevel: NsfwLevel.X, minorByScan }),
        collaborators: [],
      } as never);
      r.$queryRaw.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) =>
        Promise.resolve(
          sqlOfRaw(strings, values).includes('WITH RECURSIVE main')
            ? [
                { id: 1, postId: 101, depth: 0, parentIds: [] },
                { id: 2, postId: 102, depth: 1, parentIds: [] },
              ]
            : []
        )) as never);
      r.user.findMany.mockResolvedValue([] as never);
      r.post.findMany.mockResolvedValue(
        [101, 102].map((id) => ({
          id,
          userId: OWNER,
          title: `post ${id}`,
          nsfwLevel: id === 102 ? R : NsfwLevel.PG,
          publishedAt: new Date('2026-10-01'),
          tosViolation: false,
          user: { id: OWNER, username: 'owner', image: null, profilePicture: null, ...notBanned },
        })) as never
      );
      const page = await getStoryline({ id: 10, viewer: { id: STRANGER }, browsingLevel: ALL });
      expect(page.mainPath.map((c) => c.tombstone)).toEqual([
        null,
        minorByScan ? 'aboveStoryRating' : null,
      ]);
    });
  });
});

describe('the title scan’s minor finding, beyond the scan', () => {
  // getPath is public: readers get the ceiling chapters are held to, never the finding itself.
  it.each([
    [true, NsfwLevel.PG13],
    [false, NsfwLevel.X],
  ])(
    'a reading path serves no minor flag (held: %s), only the ceiling',
    async (minorByScan, ceiling) => {
      r.storyline.findUnique.mockResolvedValue(
        storylineRow({ maxNsfwLevel: NsfwLevel.X, minorByScan }) as never
      );
      r.storylineChapter.findUnique.mockResolvedValue({ storylineId: 10, depth: 0 } as never);
      r.$queryRaw.mockResolvedValue([] as never);
      r.post.findMany.mockResolvedValue([] as never);
      getBlockedPairIds.mockResolvedValue([]);
      const { storyline } = await getStorylinePath({
        chapterId: 1,
        viewer: undefined,
        browsingLevel: NsfwLevel.PG,
      });
      for (const field of ['minorByScan', 'nsfwLevel', 'moderatorNsfwLevel'])
        expect(storyline).not.toHaveProperty(field);
      expect(storyline.maxNsfwLevel).toBe(ceiling);
    }
  );

  // The rule the scan applies, when the NSFW rating arrives from a moderator instead.
  describe('a moderator rating a minor-flagged title NSFW', () => {
    const text = textScanTextHash(storylineTextScanSubject({ userId: OWNER, title: 'T' }));
    const takedown = {
      where: {
        id: 10,
        title: 'T',
        minorByScan: true,
        tosViolationByScan: false,
        OR: [{ scanFlagLiftedTextHash: null }, { scanFlagLiftedTextHash: { not: text } }],
      },
      data: { tosViolation: true, tosViolationByScan: true },
    };
    beforeEach(() => {
      createNotification.mockClear();
      w.storyline.findUnique.mockResolvedValue({
        tosViolationByScan: false,
        title: 'T',
        userId: OWNER,
      } as never);
      w.storyline.updateMany.mockResolvedValue({ count: 1 } as never);
      w.storyline.findUniqueOrThrow.mockResolvedValue({ id: 10 } as never);
    });

    it('takes it down as the scan would, not for text a moderator cleared, and tells the owner', async () => {
      await moderateStorylineTitle({ id: 10, moderatorNsfwLevel: NsfwLevel.R });
      expect(w.storyline.updateMany.mock.calls.map(([call]) => call)).toEqual([
        { where: { id: 10 }, data: { moderatorNsfwLevel: NsfwLevel.R } },
        takedown,
      ]);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER,
          details: { storylineId: 10, takenDown: true, title: 'T' },
        })
      );
    });

    it('takes nothing down below R, and says nothing when nothing was taken down', async () => {
      await moderateStorylineTitle({ id: 10, moderatorNsfwLevel: NsfwLevel.PG13 });
      expect(w.storyline.updateMany).toHaveBeenCalledTimes(1);
      w.storyline.updateMany.mockClear();
      w.storyline.updateMany
        .mockResolvedValueOnce({ count: 1 } as never)
        .mockResolvedValueOnce({ count: 0 } as never);
      await moderateStorylineTitle({ id: 10, moderatorNsfwLevel: NsfwLevel.R });
      expect(createNotification).not.toHaveBeenCalled();
    });

    // A lift records the reviewed text, so the takedown that follows in the same call skips it:
    // a moderator can clear a false positive and still rate the title R.
    it('in the same call as a lift, writes the lift with the hash the takedown then skips', async () => {
      w.storyline.findUnique.mockResolvedValue({
        tosViolationByScan: true,
        title: 'T',
        userId: OWNER,
      } as never);
      await moderateStorylineTitle({
        id: 10,
        moderatorNsfwLevel: NsfwLevel.R,
        liftScanTakedown: { reviewedTitle: 'T' },
      });
      const calls = w.storyline.updateMany.mock.calls.map(([call]) => call);
      expect(calls[0]).toMatchObject({ data: { scanFlagLiftedTextHash: text } });
      expect(calls.at(-1)).toEqual(takedown);
    });
  });
});

describe('getStoryline — title appeal', () => {
  const page = (
    takedown: Record<string, boolean>,
    viewer: { id: number; isModerator?: boolean }
  ) => {
    r.storyline.findUnique.mockResolvedValue({
      ...storylineRow({ tosViolation: true, ...takedown }),
      collaborators: [],
    } as never);
    r.$queryRaw.mockResolvedValue([] as never);
    r.user.findMany.mockResolvedValue([] as never);
    r.post.findMany.mockResolvedValue([] as never);
    return getStoryline({ id: 10, viewer, browsingLevel: NsfwLevel.PG });
  };
  const byScan = { tosViolationByScan: true, tosViolationByModerator: false };
  const lastAppeal = { id: 4, status: 'Rejected', resolvedAt: new Date('2026-10-02') };

  beforeEach(() => {
    r.appeal.findFirst.mockReset().mockResolvedValue(lastAppeal as never);
  });

  it("offers the owner an appeal of the scan's takedown, with their last one", async () => {
    const asOwner = await page(byScan, { id: OWNER });
    expect(asOwner).toMatchObject({ titleAppealable: true, titleAppeal: lastAppeal });
    expect(r.appeal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'Storyline', entityId: 10, userId: OWNER, category: null },
      })
    );
    for (const field of ['tosViolationByScan', 'tosViolationByModerator'])
      expect(asOwner).not.toHaveProperty(field);
  });

  it("offers none to a moderator viewing it, nor over a moderator's takedown", async () => {
    await expect(page(byScan, { id: MODERATOR, isModerator: true })).resolves.toMatchObject({
      titleAppealable: false,
      titleAppeal: null,
    });
    await expect(
      page({ ...byScan, tosViolationByModerator: true }, { id: OWNER })
    ).resolves.toMatchObject({ titleAppealable: false, titleAppeal: null });
    expect(r.appeal.findFirst).not.toHaveBeenCalled();
  });
});

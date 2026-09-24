import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * User-blocking enforcement on write/interaction paths.
 *
 * Blocking used to be enforced read-side only (a blocked viewer 404s on the
 * entity page), so a blocked user could still comment / reply / react / review
 * the creator's content via direct tRPC/API calls. `throwIfBlockedByEntityOwner`
 * closes that gap by resolving the content owner and throwing NotFound (mirroring
 * the read handlers) when the acting user is blocked by that owner.
 */

const { amIBlockedByUser } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
}));

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));

import {
  getBlockCheckOwnerIds,
  getBlockCheckOwnerIdsForComment,
  getBlockCheckOwnerIdsForModelComment,
  getBlockCheckOwnerIdsForReply,
  throwIfBlockedByEntityOwner,
  throwIfBlockedByOwners,
} from '~/server/services/block-check.service';
import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbWrite;

const OWNER = 100;
const VIEWER = 7;

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
});

describe('getBlockCheckOwnerIds — owner resolution per entity type', () => {
  it('resolves the image owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the post owner', async () => {
    mockDb.post.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'post', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model owner', async () => {
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the resourceReview owner (review + resourceReview aliases)', async () => {
    mockDb.resourceReview.findUnique.mockResolvedValue({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'review', entityId: 1 })).toEqual([OWNER]);
    expect(await getBlockCheckOwnerIds({ entityType: 'resourceReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  // Author AND the model owner, matching the `comment` branch below. Author alone left the
  // reaction path (the only `commentOld` consumer) open under a blocker's model.
  it('resolves the legacy comment (commentOld) author and the model owner', async () => {
    const COMMENT_AUTHOR = 55;
    mockDb.comment.findUnique.mockResolvedValueOnce({ userId: COMMENT_AUTHOR, modelId: 3 });
    mockDb.model.findUnique.mockResolvedValueOnce({ userId: OWNER });

    expect(await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: 1 })).toEqual([
      COMMENT_AUTHOR,
      OWNER,
    ]);
    expect(mockDb.model.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { userId: true },
    });
  });

  it('resolves nothing for a legacy comment that no longer exists', async () => {
    mockDb.comment.findUnique.mockResolvedValueOnce(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'commentOld', entityId: 1 })).toEqual([]);
  });

  it('resolves the model3d owner', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3d', entityId: 1 })).toEqual([OWNER]);
  });

  it('resolves the model3dReview owner', async () => {
    mockDb.model3DReview.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'model3dReview', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the comicChapter owner via its project', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    expect(await getBlockCheckOwnerIds({ entityType: 'comicChapter', entityId: 1 })).toEqual([
      OWNER,
    ]);
  });

  it('resolves the appListing owner by its integer surrogate, not its ULID', async () => {
    mockDb.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'appListing', entityId: 42 })).toEqual([
      OWNER,
    ]);
    expect(mockDb.appListing.findUnique).toHaveBeenCalledWith({
      where: { serialId: 42 },
      select: { userId: true },
    });
  });

  it('resolves the challenge creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: OWNER });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([OWNER]);
  });

  it('returns [] for a system challenge with no creator', async () => {
    mockDb.challenge.findUnique.mockResolvedValueOnce({ createdById: null });
    expect(await getBlockCheckOwnerIds({ entityType: 'challenge', entityId: 1 })).toEqual([]);
  });

  it('returns [] when the entity does not exist', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce(null);
    expect(await getBlockCheckOwnerIds({ entityType: 'image', entityId: 1 })).toEqual([]);
  });
});

describe('getBlockCheckOwnerIdsForModelComment — legacy model comments', () => {
  const PARENT_AUTHOR = 55;
  const OTHER_OWNER = 200;
  const STORED_MODEL = 1;
  const REQUEST_MODEL = 2;
  const PARENT_ID = 9;

  // Keyed on the id asked for rather than on call order: the resolver reads models and comments
  // through the shared switch, so a `…Once` queue here would be consumed by whichever lookup ran
  // first and the assertion would pass on an empty answer.
  const owners = ({
    models = {},
    comments = {},
  }: {
    models?: Record<number, number>;
    comments?: Record<number, { userId: number; modelId: number }>;
  }) => {
    mockDb.model.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: number } }).where.id;
      return models[id] ? { userId: models[id] } : null;
    });
    mockDb.comment.findUnique.mockImplementation(async (args: unknown) => {
      const id = (args as { where: { id: number } }).where.id;
      return comments[id] ?? null;
    });
  };

  it('resolves the model owner for a new top-level comment', async () => {
    owners({ models: { [REQUEST_MODEL]: OWNER } });
    expect(await getBlockCheckOwnerIdsForModelComment({ modelId: REQUEST_MODEL })).toEqual([OWNER]);
  });

  it('resolves the parent author as well as the model owner for a reply', async () => {
    owners({
      models: { [REQUEST_MODEL]: OWNER },
      comments: { [PARENT_ID]: { userId: PARENT_AUTHOR, modelId: REQUEST_MODEL } },
    });
    expect(
      await getBlockCheckOwnerIdsForModelComment({ modelId: REQUEST_MODEL, parentId: PARENT_ID })
    ).toEqual([OWNER, PARENT_AUTHOR]);
  });

  it('resolves an edit target from the stored comment, not only the request', async () => {
    // Stored on a model owned by OTHER_OWNER; the request re-homes it onto one owned by OWNER.
    owners({
      models: { [STORED_MODEL]: OTHER_OWNER, [REQUEST_MODEL]: OWNER },
      comments: { 5: { userId: 42, modelId: STORED_MODEL } },
    });

    expect(
      await getBlockCheckOwnerIdsForModelComment({ commentId: 5, modelId: REQUEST_MODEL })
    ).toEqual([OWNER, OTHER_OWNER]);
    expect(mockDb.comment.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { modelId: true, parentId: true },
    });
  });

  it('resolves the stored parent author on an edit', async () => {
    owners({
      models: { [STORED_MODEL]: OWNER },
      comments: {
        5: { userId: 42, modelId: STORED_MODEL, parentId: PARENT_ID } as never,
        [PARENT_ID]: { userId: PARENT_AUTHOR, modelId: STORED_MODEL },
      },
    });

    expect(
      await getBlockCheckOwnerIdsForModelComment({ commentId: 5, modelId: STORED_MODEL })
    ).toEqual([OWNER, PARENT_AUTHOR]);
  });

  it('returns [] when nothing resolves', async () => {
    owners({});
    expect(await getBlockCheckOwnerIdsForModelComment({ commentId: 5 })).toEqual([]);
  });
});

describe('throwIfBlockedByEntityOwner — enforcement', () => {
  it('throws NotFound when the acting user is blocked by the content owner', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
  });

  // `commentOld` has one consumer, `toggleReaction` (reaction.service.ts) — the legacy comment
  // surface has no reaction of its own. Widening the arm to the model owner therefore changes
  // reaction behaviour: reacting to somebody else's comment under a blocker's model now refuses.
  it('refuses a reaction on a legacy comment when the MODEL owner blocks, not just the author', async () => {
    const COMMENT_AUTHOR = 55;
    mockDb.comment.findUnique.mockResolvedValue({ userId: COMMENT_AUTHOR, modelId: 3 });
    mockDb.model.findUnique.mockResolvedValue({ userId: OWNER });
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OWNER
    );

    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'commentOld', entityId: 1 })
    ).rejects.toThrow();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
  });

  it('allows that reaction when neither the author nor the model owner blocks', async () => {
    mockDb.comment.findUnique.mockResolvedValue({ userId: 55, modelId: 3 });
    mockDb.model.findUnique.mockResolvedValue({ userId: OWNER });

    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'commentOld', entityId: 1 })
    ).resolves.toBeUndefined();
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
  });

  it('rejects a blocked user creating a model3d comment', async () => {
    mockDb.model3D.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'model3d', entityId: 1 })
    ).rejects.toThrow();
  });

  it('rejects a blocked user creating a comicChapter comment', async () => {
    mockDb.comicChapter.findUnique.mockResolvedValueOnce({ project: { userId: OWNER } });
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comicChapter', entityId: 1 })
    ).rejects.toThrow();
  });

  it('does not throw when the acting user is NOT blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: 1 })
    ).resolves.toBeUndefined();
  });

  it('never blocks the owner acting on their own content (owner === viewer)', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    await throwIfBlockedByEntityOwner({ userId: OWNER, entityType: 'image', entityId: 1 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  it('exempts moderators even when blocked', async () => {
    mockDb.image.findUnique.mockResolvedValueOnce({ userId: OWNER });
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      throwIfBlockedByEntityOwner({
        userId: VIEWER,
        entityType: 'image',
        entityId: 1,
        isModerator: true,
      })
    ).resolves.toBeUndefined();
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});

describe('throwIfBlockedByOwners — reply / legacy-comment helper', () => {
  it('throws if blocked by ANY of the supplied owners (e.g. parent comment author)', async () => {
    amIBlockedByUser.mockImplementation(async ({ targetUserId }: { targetUserId: number }) => {
      return targetUserId === 55; // blocked by the parent comment author only
    });
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, 55] })
    ).rejects.toThrow();
  });

  it('skips null/undefined owner ids and passes when none block', async () => {
    amIBlockedByUser.mockResolvedValue(false);
    await expect(
      throwIfBlockedByOwners({ userId: VIEWER, ownerIds: [OWNER, null, undefined] })
    ).resolves.toBeUndefined();
  });
});

/**
 * `Thread.rootThreadId` and `Thread.parentThreadId` are written from the first replier's request, so
 * every pointer below that disagrees with the stored `Thread.commentId -> CommentV2.threadId` chain
 * is one a client chose. The block targets must come from the chain.
 */
describe('CommentV2 block targets — root owner from the stored thread chain', () => {
  const OTHER_OWNER = 300;
  const PARENT_AUTHOR = 55;
  const REPLY_AUTHOR = 56;

  const TOP_LEVEL = 10;
  const REPLY = 11;
  const ORPHANED = 13;
  const DEEP_TOP = 20_000;
  const CHAIN_LENGTH = 105;
  const DEEPEST = DEEP_TOP + CHAIN_LENGTH;

  type FakeThread = Record<string, number | null | undefined>;
  const threads: Record<number, FakeThread> = {
    50: { imageId: 1 },
    60: { imageId: 2 },
    52: { commentId: TOP_LEVEL, rootThreadId: 60, parentThreadId: 60 },
    70: { commentId: null, rootThreadId: 50, parentThreadId: 50 },
    10_000: { imageId: 1 },
  };
  const comments: Record<number, { userId: number; threadId: number }> = {
    [TOP_LEVEL]: { userId: PARENT_AUTHOR, threadId: 50 },
    [REPLY]: { userId: REPLY_AUTHOR, threadId: 52 },
    [ORPHANED]: { userId: PARENT_AUTHOR, threadId: 70 },
  };
  // A chain longer than the walk's cap, rooted on OWNER's image — so the cap, not the data, is what
  // leaves it unresolved.
  for (let i = 0; i <= CHAIN_LENGTH; i++) {
    comments[DEEP_TOP + i] = { userId: PARENT_AUTHOR, threadId: 10_000 + i };
    threads[10_000 + i + 1] = { commentId: DEEP_TOP + i, rootThreadId: 50 };
  }
  const imageOwners: Record<number, number> = { 1: OWNER, 2: OTHER_OWNER };

  // Every owner-bearing `Thread` column, with the lookup `ownerOfThreadContent` makes for it. Each
  // gets a rooted thread of its own below, so a column missing from `threadIsRooted` refuses its
  // replies and one missing from `threadContentSelect` loses its owner — both show up as a failure.
  const ownerLookups = {
    imageId: { table: 'image', ownerKey: 'userId', whereKey: 'id' },
    postId: { table: 'post', ownerKey: 'userId', whereKey: 'id' },
    articleId: { table: 'article', ownerKey: 'userId', whereKey: 'id' },
    modelId: { table: 'model', ownerKey: 'userId', whereKey: 'id' },
    reviewId: { table: 'resourceReview', ownerKey: 'userId', whereKey: 'id' },
    bountyId: { table: 'bounty', ownerKey: 'userId', whereKey: 'id' },
    bountyEntryId: { table: 'bountyEntry', ownerKey: 'userId', whereKey: 'id' },
    questionId: { table: 'question', ownerKey: 'userId', whereKey: 'id' },
    answerId: { table: 'answer', ownerKey: 'userId', whereKey: 'id' },
    model3dId: { table: 'model3D', ownerKey: 'userId', whereKey: 'id' },
    model3dReviewId: { table: 'model3DReview', ownerKey: 'userId', whereKey: 'id' },
    comicProjectId: { table: 'comicProject', ownerKey: 'userId', whereKey: 'id' },
    challengeId: { table: 'challenge', ownerKey: 'createdById', whereKey: 'id' },
    appListingId: { table: 'appListing', ownerKey: 'userId', whereKey: 'serialId' },
  } as const;
  // Rooted, but with no owner lookup: the replies are allowed, with no content owner to check.
  const OWNERLESS_ROOT_COLUMN = 'clubPostId';
  const CONTENT_ID = 7;
  const rootCommentFor: Record<string, number> = {};
  // A distinct owner per table, so a column whose lookup reads the wrong table resolves the wrong
  // user rather than the same one.
  const tableOwner: Record<string, number> = {};
  [...Object.keys(ownerLookups), OWNERLESS_ROOT_COLUMN].forEach((column, i) => {
    threads[30_000 + i] = { [column]: CONTENT_ID };
    comments[31_000 + i] = { userId: PARENT_AUTHOR, threadId: 30_000 + i };
    rootCommentFor[column] = 31_000 + i;
    const lookup = ownerLookups[column as keyof typeof ownerLookups];
    if (lookup) tableOwner[lookup.table] = 1_000 + i;
  });
  imageOwners[CONTENT_ID] = tableOwner.image;

  let lastRootedColumns: string[] = [];

  /**
   * Stands in for Postgres on the walk: every row from the seed up, with its depth, honouring the
   * query's own cap, ORDER BY and LIMIT. `rooted` is answered only when the query selects one, from
   * the columns and alias the query itself names.
   */
  function runChainWalk(sql: string) {
    let id = Number(/SELECT (\d+) "id"/.exec(sql)?.[1]);
    const cap = Number(/mt\."depth" < (\d+)/.exec(sql)?.[1]);
    const rows = [{ id, depth: 0 }];
    for (let depth = 1; depth <= cap; depth++) {
      const parent = threads[id]?.commentId;
      if (parent == null || !comments[parent]) break;
      id = comments[parent].threadId;
      rows.push({ id, depth });
    }
    const order = /ORDER BY mt\."depth" (ASC|DESC)/.exec(sql)?.[1];
    if (!order) throw new Error(`owner walk has no depth ordering: ${sql}`);
    rows.sort((x, y) => (order === 'DESC' ? y.depth - x.depth : x.depth - y.depth));
    const rootedArgs = /num_nonnulls\(([\s\S]*?)\) > 0 "rooted"/.exec(sql)?.[1];
    let rootedColumns: string[] | undefined;
    if (rootedArgs !== undefined) {
      const refs = [...rootedArgs.matchAll(/(\w+)\."(\w+)"/g)];
      if (!refs.length || refs.some(([, alias]) => alias !== 'th'))
        throw new Error(`rootedness must read the top thread "th": ${rootedArgs}`);
      if (!/JOIN "Thread" th ON th\.id = top\."id"/.test(sql))
        throw new Error(`"th" is not joined to the top of the walk: ${sql}`);
      rootedColumns = refs.map(([, , column]) => column);
      lastRootedColumns = rootedColumns;
    }
    // The outer query has no ORDER BY of its own, so without the LIMIT the row order is unspecified.
    if (!/LIMIT 1\b/.test(sql))
      throw new Error(`owner walk does not take a single top row: ${sql}`);
    return rows
      .slice(0, 1)
      .map((row) =>
        rootedColumns
          ? { ...row, rooted: rootedColumns.some((c) => threads[row.id]?.[c] != null) }
          : row
      );
  }

  const project = (row: FakeThread | undefined, select?: Record<string, unknown>) =>
    row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : row;

  beforeEach(() => {
    // `clearAllMocks` keeps `…Once` values an earlier test queued and never consumed (the moderator
    // test above leaves an image owner behind), and they would answer ahead of these fakes.
    for (const fn of [mockDb.$queryRaw, mockDb.commentV2.findUnique, mockDb.thread.findUnique])
      fn.mockReset();
    lastRootedColumns = [];
    for (const { table, ownerKey, whereKey } of Object.values(ownerLookups)) {
      const findUnique = mockDb[table].findUnique;
      findUnique.mockReset();
      findUnique.mockImplementation((async ({ where }: { where: Record<string, number> }) =>
        where[whereKey] === CONTENT_ID ? { [ownerKey]: tableOwner[table] } : null) as never);
    }
    mockDb.$queryRaw.mockImplementation((async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => runChainWalk(Prisma.sql(strings, ...(values as never[])).sql)) as never);
    mockDb.commentV2.findUnique.mockImplementation((async ({
      where,
      select,
    }: {
      where: { id: number };
      select?: Record<string, unknown>;
    }) => {
      const c = comments[where.id];
      if (!c) return null;
      const thread = project(threads[c.threadId], (select?.thread as { select?: never })?.select);
      return { ...c, thread };
    }) as never);
    mockDb.thread.findUnique.mockImplementation(
      (async ({ where, select }: { where: { id: number }; select?: Record<string, unknown> }) =>
        project(threads[where.id], select) ?? null) as never
    );
    mockDb.image.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      imageOwners[where.id] ? { userId: imageOwners[where.id] } : null) as never);
  });

  it('creating a reply checks the real content owner, not the forged root pointer', async () => {
    expect(await getBlockCheckOwnerIdsForReply(REPLY)).toEqual([REPLY_AUTHOR, OWNER]);
  });

  it('editing a reply checks the real content owner, not the forged root pointer', async () => {
    expect(await getBlockCheckOwnerIdsForComment(REPLY)).toEqual([PARENT_AUTHOR, OWNER]);
  });

  it('reacting to a reply checks the real content owner, not the forged root pointer', async () => {
    expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: REPLY })).toEqual([
      REPLY_AUTHOR,
      OWNER,
    ]);
  });

  it('refuses a reaction when only the real content owner blocks', async () => {
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OWNER
    );
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'comment', entityId: REPLY })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
    expect(amIBlockedByUser).not.toHaveBeenCalledWith({
      userId: VIEWER,
      targetUserId: OTHER_OWNER,
    });
  });

  it('resolves a top-level comment to its own thread content', async () => {
    expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: TOP_LEVEL })).toEqual([
      PARENT_AUTHOR,
      OWNER,
    ]);
  });

  it.each(Object.keys(ownerLookups))('resolves the owner of a %s root', async (column) => {
    const { table } = ownerLookups[column as keyof typeof ownerLookups];
    expect(await getBlockCheckOwnerIdsForReply(rootCommentFor[column])).toEqual([
      PARENT_AUTHOR,
      tableOwner[table],
    ]);
  });

  it('treats a clubPostId root as resolved, with no content owner to check', async () => {
    expect(await getBlockCheckOwnerIdsForReply(rootCommentFor[OWNERLESS_ROOT_COLUMN])).toEqual([
      PARENT_AUTHOR,
    ]);
  });

  // A column added to `threadIsRooted` without a row in `ownerLookups` is a content type these
  // tests never resolve an owner for.
  it('covers every column the walk counts as a content root', async () => {
    await getBlockCheckOwnerIdsForReply(TOP_LEVEL);
    expect([...lastRootedColumns].sort()).toEqual(
      [...Object.keys(ownerLookups), OWNERLESS_ROOT_COLUMN].sort()
    );
  });

  describe.each([
    ['an orphaned chain', ORPHANED],
    ['a chain past the depth cap', DEEPEST],
  ])('%s, which resolves no root', (_label, commentId) => {
    it('refuses creating a reply', async () => {
      await expect(getBlockCheckOwnerIdsForReply(commentId)).rejects.toThrow(
        'comment thread is no longer available'
      );
    });

    it('refuses an edit', async () => {
      await expect(getBlockCheckOwnerIdsForComment(commentId)).rejects.toThrow(
        'comment thread is no longer available'
      );
    });

    // Reactions have no lock walk to refuse them, and orphaned chains are ordinary data: they fall
    // back to the comment author alone rather than refusing every reaction there.
    it('lets a reaction fall back to the comment author alone', async () => {
      expect(await getBlockCheckOwnerIds({ entityType: 'comment', entityId: commentId })).toEqual([
        PARENT_AUTHOR,
      ]);
    });
  });
});

/**
 * Every target here exists on the primary and not yet on the replica: the moments after it was
 * written. A guard reading the replica resolves no owner for it, and no owner means allow.
 */
describe('block targets resolve from the primary, where the guarded write lands', () => {
  const PARENT_AUTHOR = 55;
  const PARENT = 10;
  const REPLY = 11;
  const MISSING = 12;
  const IMAGE = 1;
  const primaryComments: Record<number, { userId: number; threadId: number }> = {
    [PARENT]: { userId: PARENT_AUTHOR, threadId: 50 },
    [REPLY]: { userId: 56, threadId: 52 },
  };
  const primaryThreads: Record<number, { imageId?: number; commentId?: number }> = {
    50: { imageId: IMAGE },
    52: { commentId: PARENT },
  };

  beforeEach(() => {
    const replica = dbMock.dbRead;
    for (const fn of [
      mockDb.$queryRaw,
      mockDb.commentV2.findUnique,
      mockDb.thread.findUnique,
      mockDb.image.findUnique,
      replica.$queryRaw,
      replica.commentV2.findUnique,
      replica.thread.findUnique,
      replica.image.findUnique,
    ])
      fn.mockReset();
    replica.$queryRaw.mockResolvedValue([] as never);
    replica.commentV2.findUnique.mockResolvedValue(null as never);
    replica.thread.findUnique.mockResolvedValue(null as never);
    replica.image.findUnique.mockResolvedValue(null as never);

    mockDb.commentV2.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => {
      const c = primaryComments[where.id];
      return c
        ? { ...c, thread: { commentId: primaryThreads[c.threadId]?.commentId ?? null } }
        : null;
    }) as never);
    // Every thread here tops out at 50, which is rooted on the image.
    mockDb.$queryRaw.mockResolvedValue([{ id: 50, rooted: true }] as never);
    mockDb.thread.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      primaryThreads[where.id] ? { imageId: null, ...primaryThreads[where.id] } : null) as never);
    mockDb.image.findUnique.mockImplementation((async ({ where }: { where: { id: number } }) =>
      where.id === IMAGE ? { userId: OWNER } : null) as never);
  });

  it('a reply to a comment the replica has not seen yet checks its author and content owner', async () => {
    expect(await getBlockCheckOwnerIdsForReply(PARENT)).toEqual([PARENT_AUTHOR, OWNER]);
  });

  it('an edit of a reply the replica has not seen yet checks the parent author and content owner', async () => {
    expect(await getBlockCheckOwnerIdsForComment(REPLY)).toEqual([PARENT_AUTHOR, OWNER]);
  });

  it('a write on content the replica has not seen yet is refused when its owner blocks', async () => {
    amIBlockedByUser.mockImplementation(
      async (args) => (args as { targetUserId: number }).targetUserId === OWNER
    );
    await expect(
      throwIfBlockedByEntityOwner({ userId: VIEWER, entityType: 'image', entityId: IMAGE })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // Read from the primary, a missing comment does not exist. Refusing costs nothing on these paths
  // and does not depend on the write failing later.
  it('refuses a reply to a comment the primary does not have', async () => {
    await expect(getBlockCheckOwnerIdsForReply(MISSING)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses an edit of a comment the primary does not have', async () => {
    await expect(getBlockCheckOwnerIdsForComment(MISSING)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

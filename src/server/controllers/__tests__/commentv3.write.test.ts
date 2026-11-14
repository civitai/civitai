import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Surfaces from '~/server/services/commentv3/surfaces';
import type * as WriteService from '~/server/services/commentv3/write.service';
import type { StoredCommentV3 } from '~/server/services/commentv3/write.service';

// Who may write what through the commentv3 router, and what each write checks and triggers. The SQL
// these call is covered against real Postgres in services/commentv3/__tests__/write.sql.behavior.test.ts,
// including `getV3WriteComment`, which this file replaces with the same rule over a map.

const m = vi.hoisted(() => ({
  stored: new Map<number, StoredCommentV3>(),
  insertComment: vi.fn(),
  updateCommentContent: vi.fn(),
  deleteComments: vi.fn(async () => [] as unknown[]),
  setCommentFlags: vi.fn<typeof WriteService.setCommentFlags>(async () => []),
  isCommentWriteLocked: vi.fn(async () => false),
  visible: vi.fn(async (_: unknown, _ctx?: unknown) => undefined),
  access: vi.fn(async (_: unknown) => [{ hasAccess: true }]),
  blocklist: vi.fn(async (_: unknown) => undefined),
  blockOwners: vi.fn(async (_: unknown) => [] as number[]),
  throwIfBlockedByOwners: vi.fn(async (_: unknown) => undefined),
  spend: vi.fn(async (_: unknown) => new Map()),
  scan: vi.fn(),
  tos: vi.fn(async (_: unknown) => ({ count: 1 })),
  onTopicCommentsRemoved: vi.fn(async (_: unknown) => undefined),
  onCommentCreated: vi.fn(async (_: unknown) => undefined),
  getStored: vi.fn(),
  deleteComments3: vi.fn(),
  afterDeleted: vi.fn(async (_: unknown) => undefined),
  metric: vi.fn(async (_: unknown) => undefined),
  authors: vi.fn(async (..._a: unknown[]) => (_id: number): object => ({})),
  authorRow: vi.fn(async (): Promise<object | undefined> => undefined),
}));

vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => {
  const actual = await importOriginal<typeof WriteService>();
  return {
    ...actual,
    getStoredComment: (db: unknown, id: number, lock?: string) => m.getStored(db, id, lock),
    getV3WriteComment: async (_db: unknown, id: number) => {
      const row = m.stored.get(id);
      return row && !row.deletedAt ? row : undefined;
    },
    insertComment: m.insertComment,
    updateCommentContent: m.updateCommentContent,
    deleteComments: m.deleteComments,
    setCommentFlags: m.setCommentFlags,
    isCommentWriteLocked: m.isCommentWriteLocked,
  };
});
// Each surface's own rules, with the visibility check replaced so a test can refuse it.
vi.mock('~/server/services/commentv3/surfaces', async (importOriginal) => {
  const actual = await importOriginal<typeof Surfaces>();
  return {
    ...actual,
    commentSurface: (entityType: string) => ({
      ...actual.commentSurface(entityType),
      assertVisible: (entityId: number, ctx: unknown) => m.visible({ entityType, entityId }, ctx),
    }),
  };
});
vi.mock('~/server/services/block-check.service', () => ({
  getBlockCheckOwnerIds: m.blockOwners,
  throwIfBlockedByOwners: m.throwIfBlockedByOwners,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: m.blocklist,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: m.access }));
vi.mock('~/server/services/commentv3/moderation.service', () => ({
  bulkSetCommentV3TosViolation: m.tos,
  deleteCommentsV3: m.deleteComments3,
  afterCommentsV3Deleted: m.afterDeleted,
}));
vi.mock('~/server/services/sticker.service', () => ({
  spendStickerUses: m.spend,
  recordStickerUsage: vi.fn(),
}));
vi.mock('~/server/utils/metric-helpers', () => ({ updateEntityMetric: m.metric }));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: m.scan }));
vi.mock('~/server/events/points/hooks', () => ({
  onCommentCreated: m.onCommentCreated,
  onTopicCommentsRemoved: m.onTopicCommentsRemoved,
}));
vi.mock('~/server/services/user.service', () => ({
  getCosmeticsAndProfilePicturesForUsers: m.authors,
}));
vi.mock('~/server/db/kyselyDb', () => {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: () => m.authorRow(),
  };
  return { kyselyV3Read: { selectFrom: () => query } };
});

const {
  createCommentV3Handler,
  deleteCommentV3Handler,
  setTosViolationV3Handler,
  toggleCommentLockV3Handler,
  toggleHideCommentV3Handler,
  togglePinCommentV3Handler,
  toggleSectionLockHandler,
  updateCommentV3Handler,
} = await import('~/server/controllers/commentv3.controller');

const AUTHOR = 2;
const PARENT_AUTHOR = 3;
const ARTICLE_OWNER = 4;
const STRANGER = 5;
const ANSWERED_AUTHOR = 6;

const row = (id: number, over: Partial<StoredCommentV3> = {}): StoredCommentV3 => ({
  id,
  entityType: 'article',
  entityId: 10,
  parentId: null,
  replyToId: null,
  userId: AUTHOR,
  content: 'hi',
  hidden: false,
  tosViolation: false,
  locked: false,
  pinnedAt: null,
  deletedAt: null,
  depth: 0,
  path: String(id),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const ctx = (id: number, isModerator = false) =>
  ({
    user: { id, isModerator },
    track: {
      comment: vi.fn(async () => undefined),
      commentEvent: vi.fn(async () => undefined),
      stickerUsage: vi.fn(),
    },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  m.stored.clear();
  m.stored.set(100, row(100, { userId: PARENT_AUTHOR }));
  m.stored.set(101, row(101, { parentId: 100, depth: 1, path: '100.101' }));
  m.stored.set(102, row(102, { deletedAt: new Date(), content: '' }));
  m.stored.set(103, row(103, { userId: ANSWERED_AUTHOR, parentId: 100, path: '100.103' }));
  m.stored.set(104, row(104, { parentId: 100, replyToId: 103, path: '100.104', hidden: true }));
  m.stored.set(200, row(200, { entityType: 'image' }));
  m.getStored.mockImplementation(async (_db: unknown, id: number) => m.stored.get(id));
  m.insertComment.mockImplementation(async (_db: unknown, args: { parentId?: number }) =>
    row(300, { parentId: args.parentId ?? null })
  );
  m.updateCommentContent.mockImplementation(async (_db: unknown, { id }: { id: number }) =>
    row(id)
  );
  m.blockOwners.mockResolvedValue([ARTICLE_OWNER]);
});

const create = (userId: number, input: Record<string, unknown>) =>
  createCommentV3Handler({
    ctx: ctx(userId),
    input: { entityType: 'article', entityId: 10, content: '<p>x</p>', ...input } as never,
  });
const update = (userId: number, id: number, isModerator = false) =>
  updateCommentV3Handler({ ctx: ctx(userId, isModerator), input: { id, content: '<p>y</p>' } });

// The next transaction runs on its own client, so a test can tell what ran inside it.
const nextTx = () => {
  const tx = { $queryRawUnsafe: vi.fn(async () => []) };
  dbMock.dbWrite.$transaction.mockImplementationOnce(async (cb: (t: unknown) => unknown) => cb(tx));
  return tx;
};
// The runner a write got: running a query on it shows which client it is bound to.
const runsOn = async (
  runner: { query: (sql: string) => Promise<unknown> },
  tx: { $queryRawUnsafe: ReturnType<typeof vi.fn> }
) => {
  tx.$queryRawUnsafe.mockClear();
  await runner.query('SELECT 1');
  return tx.$queryRawUnsafe.mock.calls.length === 1;
};

describe('commentv3 create', () => {
  it('answers the saved comment with its author as the cache has them', async () => {
    m.insertComment.mockResolvedValueOnce(row(300, { userId: STRANGER }));
    m.authorRow.mockResolvedValueOnce({
      id: STRANGER,
      username: 'ann',
      deletedAt: null,
      image: null,
    });
    m.authors.mockResolvedValueOnce((id) =>
      id === STRANGER ? { profilePicture: { id: 9 }, showcaseHat: { id: 4 } } : {}
    );
    const saved = await create(STRANGER, {});
    expect(m.authors).toHaveBeenCalledWith([STRANGER], { showcaseHat: true });
    expect(saved.user).toEqual({
      id: STRANGER,
      username: 'ann',
      deletedAt: null,
      image: null,
      profilePicture: { id: 9 },
      showcaseHat: { id: 4 },
    });
  });

  it('checks a reply against its parent author and the section owner, then writes and scans it', async () => {
    await create(STRANGER, { parentId: 100 });
    expect(m.throwIfBlockedByOwners).toHaveBeenCalledWith(
      expect.objectContaining({ userId: STRANGER, ownerIds: [PARENT_AUTHOR, ARTICLE_OWNER] })
    );
    expect(m.insertComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: 'article', entityId: 10, parentId: 100 })
    );
    expect(m.scan).toHaveBeenCalledWith({ entityType: 'CommentV3', entityId: 300 });
    expect(m.onCommentCreated).toHaveBeenCalledTimes(1);
    expect(m.onCommentCreated).toHaveBeenCalledWith({
      userId: STRANGER,
      entityType: 'article',
      entityId: 10,
    });
  });

  it.each([
    ['a member', false],
    ['a moderator', true],
  ])('passes whether %s is writing to the content and block checks', async (_, isModerator) => {
    await createCommentV3Handler({
      ctx: ctx(STRANGER, isModerator),
      input: { entityType: 'article', entityId: 10, content: '<p>x</p>' } as never,
    });
    await update(AUTHOR, 101, isModerator);
    expect(m.blocklist.mock.calls).toEqual([
      ['<p>x</p>', { isModerator }],
      ['<p>y</p>', { isModerator }],
    ]);
    for (const [args] of m.throwIfBlockedByOwners.mock.calls)
      expect(args).toMatchObject({ isModerator });
    expect(m.throwIfBlockedByOwners).toHaveBeenCalledTimes(2);
  });

  it('does not wait on the event points call', async () => {
    m.onCommentCreated.mockReturnValueOnce(new Promise(() => undefined));
    await expect(create(STRANGER, {})).resolves.toMatchObject({ id: 300 });
  });

  it('charges stickers in the insert’s transaction, so a refused insert fails the charge with it', async () => {
    const tx = nextTx();
    await create(STRANGER, { parentId: 100 });
    expect(m.spend.mock.calls[0][0]).toMatchObject({ tx });
    expect(await runsOn(m.insertComment.mock.calls[0][0], tx)).toBe(true);

    nextTx();
    m.insertComment.mockRejectedValueOnce(new Error('comment thread locked'));
    await expect(create(STRANGER, { parentId: 100 })).rejects.toThrow('comment thread locked');
    expect(m.spend).toHaveBeenCalledTimes(2);
    expect(m.scan).toHaveBeenCalledTimes(1);
  });

  it('locks the parent before charging stickers, in the order an edit takes them', async () => {
    const tx = nextTx();
    await create(STRANGER, { parentId: 100 });
    const lockIndex = m.getStored.mock.calls.findIndex(
      ([, id, lock]) => id === 100 && lock === 'FOR KEY SHARE'
    );
    expect(await runsOn(m.getStored.mock.calls[lockIndex]?.[0], tx)).toBe(true);
    expect(m.getStored.mock.invocationCallOrder[lockIndex]).toBeLessThan(
      m.spend.mock.invocationCallOrder[0]
    );
  });

  it('takes a reply section from its parent, never from the input', async () => {
    await create(STRANGER, { parentId: 100, entityId: 999 });
    expect(m.visible).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'article', entityId: 10 }),
      expect.anything()
    );
    expect(m.insertComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: 10 })
    );
  });

  it.each([
    [
      'a section the caller may not see',
      () => m.visible.mockRejectedValueOnce(new Error('hidden')),
      'hidden',
    ],
    [
      'an article the caller has no access to',
      () => m.access.mockResolvedValueOnce([{ hasAccess: false }]),
      'You do not have access to this resource.',
    ],
    [
      'blocked text',
      () => m.blocklist.mockRejectedValueOnce(new Error('blocked text')),
      'blocked text',
    ],
    [
      'a block by the section owner',
      () => m.throwIfBlockedByOwners.mockRejectedValueOnce(new Error('blocked by owner')),
      'blocked by owner',
    ],
  ])('writes nothing on %s', async (_, refuse, message) => {
    refuse();
    await expect(create(STRANGER, {})).rejects.toThrow(message);
    expect(m.insertComment).not.toHaveBeenCalled();
    expect(m.spend).not.toHaveBeenCalled();
  });

  it('refuses a reply to a deleted comment', async () => {
    await expect(create(STRANGER, { parentId: 102 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.insertComment).not.toHaveBeenCalled();
  });

  it('refuses a member a reply under a comment removed for ToS; a moderator may', async () => {
    m.stored.set(106, row(106, { tosViolation: true }));
    await expect(create(STRANGER, { parentId: 106 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.insertComment).not.toHaveBeenCalled();
    await createCommentV3Handler({
      ctx: ctx(STRANGER, true),
      input: { entityType: 'article', entityId: 10, content: '<p>x</p>', parentId: 106 } as never,
    });
    expect(m.insertComment).toHaveBeenCalledTimes(1);
  });

  describe('on a surface with its own tracking and side effects', () => {
    beforeEach(() => {
      m.insertComment.mockImplementation(async (_db: unknown, args: { parentId?: number }) =>
        row(300, { entityType: 'image', entityId: 10, parentId: args.parentId ?? null })
      );
    });
    const tracked = (c: unknown) =>
      (c as { track: { comment: ReturnType<typeof vi.fn> } }).track.comment;

    it('tracks a new comment as its surface and counts it on the image; a reply as a comment only', async () => {
      const c = ctx(STRANGER);
      await createCommentV3Handler({
        ctx: c,
        input: { entityType: 'image', entityId: 10, content: '<p>x</p>' } as never,
      });
      expect(tracked(c)).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'Image', entityId: 300 })
      );
      expect(m.metric).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'Image', entityId: 10, metricType: 'Comment' })
      );

      m.metric.mockClear();
      const reply = ctx(STRANGER);
      await createCommentV3Handler({
        ctx: reply,
        input: { entityType: 'image', entityId: 10, content: '<p>x</p>', parentId: 200 } as never,
      });
      expect(tracked(reply)).toHaveBeenCalledWith(expect.objectContaining({ type: 'Comment' }));
      expect(m.metric).not.toHaveBeenCalled();
    });
  });

  // `comments.type` is matched on downstream, so every entry is pinned, and an unmapped surface is not
  // tracked at all.
  describe('ClickHouse tracking per surface', () => {
    const surfaces: [string, string | undefined][] = [
      ['post', 'Post'],
      ['image', 'Image'],
      ['review', 'Review'],
      ['bounty', 'Bounty'],
      ['bountyEntry', 'BountyEntry'],
      ['challenge', undefined],
    ];
    it.each(surfaces)('tracks a new %s comment as %s', async (entityType, type) => {
      const c = ctx(STRANGER);
      await createCommentV3Handler({
        ctx: c,
        input: { entityType, entityId: 10, content: '<p>x</p>' } as never,
      });
      const track = (c as { track: { comment: ReturnType<typeof vi.fn> } }).track.comment;
      if (type)
        expect(track).toHaveBeenCalledWith(expect.objectContaining({ type, entityId: 300 }));
      else expect(track).not.toHaveBeenCalled();
    });

    // The model metrics job finds the models to recount by this event, replies included, so one
    // event per comment, keyed by the model.
    it('tracks a model comment and a reply once each, against the model', async () => {
      dbMock.dbRead.model.findUnique.mockResolvedValue({
        locked: false,
        modelVersions: [{ id: 1 }, { id: 2 }],
      } as never);
      m.stored.set(400, row(400, { entityType: 'model', entityId: 10 }));
      for (const parentId of [undefined, 400]) {
        m.insertComment.mockResolvedValueOnce(
          row(401, { entityType: 'model', entityId: 10, parentId: parentId ?? null })
        );
        const c = ctx(STRANGER);
        await createCommentV3Handler({
          ctx: c,
          input: { entityType: 'model', entityId: 10, content: '<p>x</p>', parentId } as never,
        });
        const track = (c as { track: { comment: ReturnType<typeof vi.fn> } }).track.comment;
        expect(track.mock.calls).toEqual([[{ type: 'Model', entityId: 10, nsfw: false }]]);
      }
    });
  });

  it('refuses a comment on a 3D model review, a section nothing renders', async () => {
    await expect(create(STRANGER, { entityType: 'model3dReview' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(m.insertComment).not.toHaveBeenCalled();
  });

  it("checks access on a storyline text's post, and refuses a text that is gone", async () => {
    dbMock.dbRead.postText.findUnique.mockResolvedValue({ postId: 77 } as never);
    m.access.mockResolvedValueOnce([{ hasAccess: false }]);
    await expect(create(STRANGER, { entityType: 'postText', entityId: 5 })).rejects.toThrow(
      'You do not have access to this resource.'
    );
    expect(m.access).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityType: 'Post', entityIds: [77] })
    );

    dbMock.dbRead.postText.findUnique.mockResolvedValue(null as never);
    await expect(create(STRANGER, { entityType: 'postText', entityId: 5 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(m.insertComment).not.toHaveBeenCalled();
  });

  it('refuses an entity type with no comment section', async () => {
    await expect(create(STRANGER, { entityType: 'nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(m.insertComment).not.toHaveBeenCalled();
  });
});

describe('commentv3 update', () => {
  it('lets only the author or a moderator edit', async () => {
    await expect(update(STRANGER, 101)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(update(ARTICLE_OWNER, 101)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await update(AUTHOR, 101);
    await update(STRANGER, 101, true);
    expect(m.updateCommentContent).toHaveBeenCalledTimes(2);
  });

  it('checks against the stored section and every comment it answers, and refuses under a lock', async () => {
    await update(AUTHOR, 104);
    expect(m.throwIfBlockedByOwners).toHaveBeenCalledWith(
      expect.objectContaining({ ownerIds: [PARENT_AUTHOR, ANSWERED_AUTHOR, ARTICLE_OWNER] })
    );
    expect(m.isCommentWriteLocked).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityId: 10, path: '100' })
    );
    m.isCommentWriteLocked.mockResolvedValueOnce(true);
    await expect(update(AUTHOR, 101)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('charges only for stickers the edit added, in the edit’s transaction, rescans, and awards no points', async () => {
    const tx = nextTx();
    await update(AUTHOR, 101);
    expect(m.spend.mock.calls[0][0]).toMatchObject({ previousContent: 'hi', tx });
    expect(await runsOn(m.updateCommentContent.mock.calls[0][0], tx)).toBe(true);
    expect(m.scan).toHaveBeenCalledWith({ entityType: 'CommentV3', entityId: 101 });
    expect(m.onCommentCreated).not.toHaveBeenCalled();
  });

  it('charges against the content as locked in the transaction, not as first read', async () => {
    const tx = nextTx();
    m.getStored.mockImplementation(async (_db: unknown, id: number, lock?: string) =>
      lock === 'FOR UPDATE'
        ? { ...m.stored.get(id), content: 'edited meanwhile' }
        : m.stored.get(id)
    );
    await update(AUTHOR, 101);
    expect(m.spend.mock.calls[0][0]).toMatchObject({ previousContent: 'edited meanwhile' });
    const locked = m.getStored.mock.calls.find(([, , lock]) => lock === 'FOR UPDATE');
    expect(await runsOn(locked?.[0], tx)).toBe(true);
  });

  it('does not edit a deleted comment', async () => {
    await expect(update(AUTHOR, 102)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('answers a member editing a comment removed for ToS as gone; a moderator may', async () => {
    m.stored.set(106, row(106, { tosViolation: true }));
    await expect(update(AUTHOR, 106)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.updateCommentContent).not.toHaveBeenCalled();
    await update(STRANGER, 106, true);
    expect(m.updateCommentContent).toHaveBeenCalledTimes(1);
  });
});

describe('commentv3 delete', () => {
  const removed = [{ id: 101, userId: AUTHOR, entityType: 'article', entityId: 10 }];

  it('lets only the author or a moderator delete, and settles points', async () => {
    m.deleteComments3.mockResolvedValue(removed);
    await expect(
      deleteCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.deleteComments3).not.toHaveBeenCalled();

    const tx = nextTx();
    await deleteCommentV3Handler({ ctx: ctx(AUTHOR), input: { id: 101 } });
    expect(m.deleteComments3).toHaveBeenCalledWith(tx, [101]);
    expect(m.afterDeleted).toHaveBeenCalledWith(removed);

    await deleteCommentV3Handler({ ctx: ctx(STRANGER, true), input: { id: 101 } });
    expect(m.deleteComments3).toHaveBeenCalledTimes(2);
  });

  it('answers a member deleting their comment removed for ToS as gone; a moderator may', async () => {
    m.stored.set(106, row(106, { tosViolation: true }));
    m.deleteComments3.mockResolvedValue([]);
    await expect(
      deleteCommentV3Handler({ ctx: ctx(AUTHOR), input: { id: 106 } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(m.deleteComments3).not.toHaveBeenCalled();
    await deleteCommentV3Handler({ ctx: ctx(STRANGER, true), input: { id: 106 } });
    expect(m.deleteComments3).toHaveBeenCalledTimes(1);
  });
});

describe('commentv3 hide and pin', () => {
  it.each([
    ['hide', toggleHideCommentV3Handler, { hidden: true }],
    ['pin', togglePinCommentV3Handler, { pinned: true }],
  ] as const)('%s is for the content owner or a moderator', async (_, handler, flags) => {
    await expect(handler({ ctx: ctx(AUTHOR), input: { id: 101 } })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } });
    await handler({ ctx: ctx(STRANGER, true), input: { id: 101 } });
    expect(m.setCommentFlags).toHaveBeenCalledTimes(2);
    expect(m.setCommentFlags).toHaveBeenCalledWith(expect.anything(), [101], flags);
    expect(m.blockOwners).toHaveBeenCalledWith({ entityType: 'article', entityId: 10 });
  });

  it.each([
    ['hide', toggleHideCommentV3Handler],
    ['pin', togglePinCommentV3Handler],
  ] as const)(
    "%s holds the owner to the section's write rules; a moderator is not",
    async (_, handler) => {
      m.access.mockResolvedValue([{ hasAccess: false }]);
      await expect(handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })).rejects.toThrow();
      expect(m.setCommentFlags).not.toHaveBeenCalled();
      await handler({ ctx: ctx(STRANGER, true), input: { id: 101 } });
      expect(m.setCommentFlags).toHaveBeenCalledTimes(1);
      m.access.mockResolvedValue([{ hasAccess: true }]);
    }
  );

  it('turns them back off', async () => {
    m.stored.set(105, row(105, { hidden: true, pinnedAt: new Date() }));
    await toggleHideCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 105 } });
    await togglePinCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 105 } });
    expect(m.setCommentFlags).toHaveBeenNthCalledWith(1, expect.anything(), [105], {
      hidden: false,
    });
    expect(m.setCommentFlags).toHaveBeenNthCalledWith(2, expect.anything(), [105], {
      pinned: false,
    });
  });

  it.each([
    ['hide', toggleHideCommentV3Handler],
    ['pin', togglePinCommentV3Handler],
  ] as const)(
    '%s answers the owner a comment removed for ToS as gone; a moderator may',
    async (_, handler) => {
      m.stored.set(106, row(106, { tosViolation: true }));
      await expect(handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 106 } })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(m.setCommentFlags).not.toHaveBeenCalled();
      await handler({ ctx: ctx(STRANGER, true), input: { id: 106 } });
      expect(m.setCommentFlags).toHaveBeenCalledTimes(1);
    }
  );
});

describe('a model with its comments locked', () => {
  beforeEach(() => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({
      locked: false,
      meta: { commentsLocked: true },
      modelVersions: [{ id: 1 }, { id: 2 }],
    } as never);
    m.stored.set(400, row(400, { entityType: 'model', entityId: 10 }));
  });

  it('takes no new comment from a member', async () => {
    await expect(create(STRANGER, { entityType: 'model' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(m.insertComment).not.toHaveBeenCalled();
  });

  it('takes no reply and no edit either', async () => {
    await expect(create(STRANGER, { entityType: 'model', parentId: 400 })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(update(AUTHOR, 400)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.insertComment).not.toHaveBeenCalled();
    expect(m.updateCommentContent).not.toHaveBeenCalled();
  });

  // The lock closes the conversation, not the owner's moderation of it.
  it('still lets its owner hide a comment', async () => {
    await expect(
      toggleHideCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 400 } })
    ).resolves.toMatchObject({ id: 400, hidden: true });
  });
});

describe('commentv3 ToS removal', () => {
  it('is for moderators only, whatever procedure the router puts it behind', async () => {
    await expect(
      setTosViolationV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.tos).not.toHaveBeenCalled();
    await setTosViolationV3Handler({ ctx: ctx(STRANGER, true), input: { id: 101 } });
    // As the calling moderator: reports are actioned and rewarded in their name.
    expect(m.tos).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [101], actor: expect.objectContaining({ id: STRANGER }) })
    );
  });

  it('is no error on a comment already removed, and refuses a deleted one', async () => {
    m.tos.mockResolvedValueOnce({ count: 0 } as never);
    await expect(
      setTosViolationV3Handler({ ctx: ctx(STRANGER, true), input: { id: 101 } })
    ).resolves.toMatchObject({ count: 0 });
    await expect(
      setTosViolationV3Handler({ ctx: ctx(STRANGER, true), input: { id: 102 } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a comment in a section the caller may not see', () => {
  it.each([
    ['edit', () => update(AUTHOR, 101)],
    ['delete', () => deleteCommentV3Handler({ ctx: ctx(AUTHOR), input: { id: 101 } })],
    ['hide', () => toggleHideCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })],
    ['pin', () => togglePinCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })],
  ])('refuses its %s, writing nothing', async (_, call) => {
    m.visible.mockRejectedValueOnce(new Error('hidden'));
    await expect(call()).rejects.toThrow('hidden');
    expect(m.visible).toHaveBeenCalledWith(
      { entityType: 'article', entityId: 10 },
      expect.anything()
    );
    expect(m.updateCommentContent).not.toHaveBeenCalled();
    expect(m.deleteComments3).not.toHaveBeenCalled();
    expect(m.setCommentFlags).not.toHaveBeenCalled();
  });
});

describe('commentv3 section lock', () => {
  it('is for moderators only, whatever procedure the router puts it behind', async () => {
    const section = { entityType: 'article', entityId: 10 } as const;
    await expect(
      toggleSectionLockHandler({ ctx: ctx(ARTICLE_OWNER), input: section })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.$queryRawUnsafe).not.toHaveBeenCalled();
    await toggleSectionLockHandler({ ctx: ctx(STRANGER, true), input: section });
    expect(dbMock.dbWrite.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('commentv3 comment lock', () => {
  const lock = (userId: number, id: number, isModerator = false) =>
    toggleCommentLockV3Handler({ ctx: ctx(userId, isModerator), input: { id } });

  it('is for moderators only, whatever procedure the router puts it behind', async () => {
    await expect(lock(ARTICLE_OWNER, 100)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    const tx = nextTx();
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: 100, locked: true }] as never);
    await expect(lock(STRANGER, 100, true)).resolves.toEqual({ id: 100, locked: true });
  });

  it('is not found on a deleted comment', async () => {
    await expect(lock(STRANGER, 102, true)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
  setCommentFlags: vi.fn(async () => [] as unknown[]),
  isCommentWriteLocked: vi.fn(async () => false),
  visible: vi.fn(async (_: unknown) => undefined),
  access: vi.fn(async (_: unknown) => [{ hasAccess: true }]),
  blocklist: vi.fn(async (_: unknown) => undefined),
  blockOwners: vi.fn(async (_: unknown) => [] as number[]),
  throwIfBlockedByOwners: vi.fn(async (_: unknown) => undefined),
  contentOwner: vi.fn(async (_: unknown) => ({
    hidden: false,
    ownerId: undefined as number | undefined,
  })),
  spend: vi.fn(async (_: unknown) => new Map()),
  scan: vi.fn(),
  tos: vi.fn(async (_: unknown) => ({ count: 1 })),
  onTopicCommentsRemoved: vi.fn(async (_: unknown) => undefined),
  onCommentCreated: vi.fn(async (_: unknown) => undefined),
  getStored: vi.fn(),
}));

vi.mock('~/server/services/commentv3/write.service', async (importOriginal) => ({
  ...(await importOriginal<typeof WriteService>()),
  getStoredComment: (db: unknown, id: number, lock?: string) => m.getStored(db, id, lock),
  getV3WriteComment: async (_db: unknown, id: number) => {
    const row = m.stored.get(id);
    return row && !row.deletedAt && row.entityType === 'article' ? row : undefined;
  },
  insertComment: m.insertComment,
  updateCommentContent: m.updateCommentContent,
  deleteComments: m.deleteComments,
  setCommentFlags: m.setCommentFlags,
  isCommentWriteLocked: m.isCommentWriteLocked,
}));
vi.mock('~/server/controllers/commentv2.controller', () => ({
  assertCommentEntityVisible: m.visible,
}));
vi.mock('~/server/services/block-check.service', () => ({
  getBlockCheckOwnerIds: m.blockOwners,
  getContentOwnerIdForComment: m.contentOwner,
  throwIfBlockedByOwners: m.throwIfBlockedByOwners,
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: m.blocklist,
}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: m.access }));
vi.mock('~/server/services/commentv3/moderation.service', () => ({
  bulkSetCommentV3TosViolation: m.tos,
}));
vi.mock('~/server/services/sticker.service', () => ({
  spendStickerUses: m.spend,
  recordStickerUsage: vi.fn(),
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: m.scan }));
vi.mock('~/server/events/points/hooks', () => ({
  onCommentCreated: m.onCommentCreated,
  onTopicCommentsRemoved: m.onTopicCommentsRemoved,
}));
vi.mock('~/server/services/user.service', () => ({
  getCosmeticsAndProfilePicturesForUsers: vi.fn(async () => () => ({})),
}));
vi.mock('~/server/db/kyselyDb', () => {
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: async () => undefined,
  };
  return { kyselyV3Read: { selectFrom: () => query } };
});

const {
  createCommentV3Handler,
  deleteCommentV3Handler,
  setTosViolationV3Handler,
  toggleHideCommentV3Handler,
  togglePinCommentV3Handler,
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
    track: { commentEvent: vi.fn(async () => undefined), stickerUsage: vi.fn() },
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
  m.contentOwner.mockResolvedValue({ hidden: false, ownerId: ARTICLE_OWNER });
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
    expect(m.onCommentCreated).toHaveBeenCalledWith({
      userId: STRANGER,
      entityType: 'article',
      entityId: 10,
    });
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

  it('refuses a surface that does not write CommentV3 yet', async () => {
    await expect(create(STRANGER, { entityType: 'image' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(create(STRANGER, { parentId: 200 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
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
});

describe('commentv3 delete', () => {
  it('lets only the author or a moderator delete, and settles points for what was removed', async () => {
    await expect(
      deleteCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.deleteComments).not.toHaveBeenCalled();

    const removed = [{ id: 101, userId: AUTHOR, entityType: 'article', entityId: 10 }];
    m.deleteComments.mockResolvedValueOnce(removed);
    await deleteCommentV3Handler({ ctx: ctx(AUTHOR), input: { id: 101 } });
    expect(m.deleteComments).toHaveBeenCalledWith(expect.anything(), [101]);
    expect(m.onTopicCommentsRemoved).toHaveBeenCalledWith(removed);
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
    expect(m.contentOwner).toHaveBeenCalledWith(101);
  });

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

  it('run in a transaction, so the row lock covers the CommentV2 sync', async () => {
    const tx = nextTx();
    await toggleHideCommentV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } });
    expect(await runsOn(m.setCommentFlags.mock.calls[0][0], tx)).toBe(true);
  });
});

describe('commentv3 ToS removal', () => {
  it('is for moderators only, whatever procedure the router puts it behind', async () => {
    await expect(
      setTosViolationV3Handler({ ctx: ctx(ARTICLE_OWNER), input: { id: 101 } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(m.tos).not.toHaveBeenCalled();
    await setTosViolationV3Handler({ ctx: ctx(STRANGER, true), input: { id: 101 } });
    expect(m.tos).toHaveBeenCalledWith(expect.objectContaining({ ids: [101] }));
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

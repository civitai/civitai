import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertComment } from '../commentsv2.service';

/**
 * The first reply to a comment creates that comment's reply thread, and the thread's
 * `parentThreadId`/`rootThreadId` must come from the parent comment's own thread. The reply and
 * thread-response notifications INNER JOIN on `rootThreadId`, and the permalink resolves a reply
 * through it, so a NULL there silently drops the notification and 404s the link. The client's
 * `parentThreadId` is a cached read that can be stale (`null` cached before the entity had any
 * comments), so it must not decide this.
 */

const db = dbMock.dbWrite;

/** The parent comment (id 50) lives on thread 42, which is nested under root thread 7. */
const PARENT_COMMENT_ID = 50;
let parentCommentThread: { id: number; rootThreadId: number | null };

beforeEach(() => {
  vi.clearAllMocks();
  parentCommentThread = { id: 42, rootThreadId: 7 };

  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('muteable_threads')) return [{ id: 0, rooted: true }];
    if (sql.includes('RECURSIVE chain')) return [{ locked: false, unresolved: false }];
    return [];
  });
  db.commentV2.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
    where.id === PARENT_COMMENT_ID ? { threadId: parentCommentThread.id } : null
  );
  db.thread.findUnique.mockImplementation(
    async ({
      where,
      select,
    }: {
      where: { id?: number; commentId?: number };
      select?: Record<string, boolean>;
    }) => {
      // No reply thread exists yet for the parent comment, so this reply creates it.
      if (where.commentId === PARENT_COMMENT_ID) return null;
      // Honours `select` like Prisma does, so dropping `rootThreadId` from it fails a test.
      if (where.id === parentCommentThread.id)
        return Object.fromEntries(
          Object.entries(parentCommentThread).filter(([key]) => select?.[key])
        );
      return null;
    }
  );
  db.thread.create.mockResolvedValue({
    id: 100,
    locked: false,
    rootThreadId: 7,
    parentThreadId: 42,
  });
  db.commentV2.create.mockResolvedValue({ id: 999 });
});

const reply = (over: Record<string, unknown> = {}) =>
  upsertComment({
    userId: 3,
    entityType: 'comment',
    entityId: PARENT_COMMENT_ID,
    content: 'a reply',
    ...over,
  } as Parameters<typeof upsertComment>[0]);

const createdThreadData = () => {
  expect(db.thread.create).toHaveBeenCalledTimes(1);
  return db.thread.create.mock.calls[0][0].data;
};

describe('upsertComment — ancestry of a new reply thread', () => {
  it('links the thread to the parent comment thread when the client sends no parentThreadId', async () => {
    await reply();

    expect(createdThreadData()).toMatchObject({
      commentId: PARENT_COMMENT_ID,
      parentThreadId: 42,
      rootThreadId: 7,
    });
  });

  it('links the thread when the client sends an explicit null parentThreadId', async () => {
    // The production shape: a `getThreadDetails` cache holding `null`.
    await reply({ parentThreadId: null });

    expect(createdThreadData()).toMatchObject({ parentThreadId: 42, rootThreadId: 7 });
  });

  it('ignores a parentThreadId that does not match the parent comment', async () => {
    await reply({ parentThreadId: 12345 });

    expect(createdThreadData()).toMatchObject({ parentThreadId: 42, rootThreadId: 7 });
  });

  it('keeps the client parentThreadId out of the comment row', async () => {
    await reply({ parentThreadId: 12345 });

    expect(db.commentV2.create.mock.calls[0][0].data).not.toHaveProperty('parentThreadId');
  });

  it('uses the parent comment thread as root when that thread is itself top-level', async () => {
    parentCommentThread = { id: 42, rootThreadId: null };

    await reply();

    expect(createdThreadData()).toMatchObject({ parentThreadId: 42, rootThreadId: 42 });
  });

  it('reuses an existing reply thread without touching its ancestry', async () => {
    db.thread.findUnique.mockImplementation(async ({ where }: { where: { commentId?: number } }) =>
      where.commentId === PARENT_COMMENT_ID ? { id: 300, locked: false } : null
    );

    await reply();

    expect(db.thread.create).not.toHaveBeenCalled();
    expect(db.commentV2.create.mock.calls[0][0].data).toMatchObject({ threadId: 300 });
  });
});

describe('upsertComment — ancestry of a new top-level thread', () => {
  it('leaves parent and root empty for a comment on an entity, whatever the client sends', async () => {
    db.thread.findUnique.mockResolvedValue(null);

    await upsertComment({
      userId: 3,
      entityType: 'image',
      entityId: 1,
      content: 'top level',
      parentThreadId: 42,
    } as Parameters<typeof upsertComment>[0]);

    expect(createdThreadData()).toMatchObject({
      imageId: 1,
      parentThreadId: null,
      rootThreadId: null,
    });
    expect(db.commentV2.findUnique).not.toHaveBeenCalled();
  });
});

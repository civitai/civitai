import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { toggleSectionMute, toggleThreadMute } from '../commentsv2.service';

/**
 * Muting a comment's thread can run before that thread exists — a comment's reply thread is created
 * lazily by the first reply. The row this creates is the SAME row `upsertComment` would have created,
 * and it must carry the same ancestry, because the reply path finds it and skips its own create.
 */

const db = dbMock.dbWrite;

beforeEach(() => {
  vi.clearAllMocks();
  db.threadMute.deleteMany.mockResolvedValue({ count: 0 });
  db.threadMute.create.mockResolvedValue({});
});

describe('toggleThreadMute', () => {
  /**
   * Mocked Prisma ignores `select`, so nothing else here can see it go missing. Dropping
   * `childThread` leaves every other assertion green while production reads `undefined` on every
   * call, takes the lazy-create branch every time, and hits the unique constraint on
   * `Thread.commentId` for any comment that already has a reply thread — i.e. the mute button fails
   * for exactly the threads people mute.
   */
  it('reads the child thread it keys the mute on', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });

    await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.commentV2.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { threadId: true, tosViolation: true, childThread: { select: { id: true } } },
    });
  });

  it('mutes the existing reply thread without creating one', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });

    const result = await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.create).not.toHaveBeenCalled();
    expect(db.threadMute.create).toHaveBeenCalledWith({
      data: { threadId: 77, userId: 1 },
    });
    expect(result).toEqual({ muted: true, threadId: 77 });
  });

  /**
   * DELIBERATE, and the reason this test exists: do not simplify the create below to
   * `{ data: { commentId } }`. A thread with a null `rootThreadId` is dropped by
   * `new-comment-reply` and `new-thread-response`, which INNER JOIN on it — so muting a thread and
   * then unmuting it would permanently delete every reply notification for that conversation, with
   * nothing failing anywhere to say so.
   */
  it('gives a lazily created reply thread the ancestry a reply would have given it', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue({ id: 10, rootThreadId: 3 });
    db.thread.upsert.mockResolvedValue({ id: 99 });

    const result = await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: 5 },
        create: { commentId: 5, parentThreadId: 10, rootThreadId: 3 },
      })
    );
    expect(result).toEqual({ muted: true, threadId: 99 });
  });

  it('roots a lazily created thread at its parent when the parent IS the root', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue({ id: 10, rootThreadId: null });
    db.thread.upsert.mockResolvedValue({ id: 99 });

    await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { commentId: 5 },
        create: { commentId: 5, parentThreadId: 10, rootThreadId: 10 },
      })
    );
  });

  it('unmutes when a mute row already existed, and writes no new one', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    db.threadMute.deleteMany.mockResolvedValue({ count: 1 });

    const result = await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.threadMute.create).not.toHaveBeenCalled();
    expect(result).toEqual({ muted: false, threadId: 77 });
  });

  it('scopes the unmute to the caller, never the whole thread', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });

    await toggleThreadMute({ commentId: 5, userId: 42 });

    expect(db.threadMute.deleteMany).toHaveBeenCalledWith({
      where: { threadId: 77, userId: 42 },
    });
  });

  /**
   * The endpoint takes a bare comment id, so without this it answers "does this id exist, and was it
   * actioned" for any signed-in caller — and would key a mute on a comment they cannot see.
   */
  it('refuses a ToS-flagged comment rather than muting it', async () => {
    db.commentV2.findUnique.mockResolvedValue({
      threadId: 10,
      tosViolation: true,
      childThread: { id: 77 },
    });

    await expect(toggleThreadMute({ commentId: 5, userId: 1 })).rejects.toThrow(
      /could not find entity/i
    );
    expect(db.threadMute.create).not.toHaveBeenCalled();
    expect(db.threadMute.deleteMany).not.toHaveBeenCalled();
  });

  it('consults the thread-lock chain before creating a reply thread', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue({ id: 10, rootThreadId: 3 });
    db.thread.upsert.mockResolvedValue({ id: 99 });
    db.$queryRaw.mockResolvedValue([{ locked: false, unresolved: false }]);

    await toggleThreadMute({ commentId: 5, userId: 1 });

    const sql = db.$queryRaw.mock.calls.map(([s]: [TemplateStringsArray]) => s.join('?')).join(' ');
    expect(sql).toContain('RECURSIVE chain');
  });

  it('refuses to create a reply thread inside a locked chain', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.$queryRaw.mockResolvedValue([{ locked: true, unresolved: false }]);

    await expect(toggleThreadMute({ commentId: 5, userId: 1 })).rejects.toThrow(/locked/i);
    expect(db.thread.upsert).not.toHaveBeenCalled();
    expect(db.threadMute.create).not.toHaveBeenCalled();
  });

  /**
   * Only the CREATE path is gated, so this must not fire when the thread already exists — a mute on
   * an existing thread is one small row and locking a thread does not stop people muting it.
   */
  it('does not consult the lock when the reply thread already exists', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });

    await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a comment that does not exist', async () => {
    db.commentV2.findUnique.mockResolvedValue(null);

    await expect(toggleThreadMute({ commentId: 5, userId: 1 })).rejects.toThrow(
      /could not find entity/i
    );
    expect(db.threadMute.create).not.toHaveBeenCalled();
  });
});

describe('toggleSectionMute', () => {
  /**
   * Deliberately never creates the root thread. No thread means no comments, so there is nothing to
   * be notified about — and creating one here would let a plain entity id be walked to insert rows
   * into `Thread`, which is large and heavily indexed.
   */
  it('does not create a thread for a section that has none', async () => {
    db.thread.findUnique.mockResolvedValue(null);

    const result = await toggleSectionMute({ entityType: 'image', entityId: 5, userId: 1 });

    expect(db.thread.create).not.toHaveBeenCalled();
    expect(db.thread.upsert).not.toHaveBeenCalled();
    expect(db.threadMute.create).not.toHaveBeenCalled();
    expect(result).toEqual({ muted: false, threadId: null });
  });

  /**
   * The mocked client ignores `where`, so without this a hardcoded `imageId` — or the wrong id
   * entirely — passes every other assertion here. Two entity types, because one cannot tell a
   * hardcoded key from a computed one.
   */
  it.each([
    ['post', 'postId'],
    ['article', 'articleId'],
  ] as const)('resolves the %s section by its own column', async (entityType, column) => {
    db.thread.findUnique.mockResolvedValue({ id: 42 });

    await toggleSectionMute({ entityType, entityId: 5, userId: 7 });

    expect(db.thread.findUnique).toHaveBeenCalledWith({
      where: { [column]: 5 },
      select: { id: true },
    });
  });

  it('mutes the existing root thread for the caller only', async () => {
    db.thread.findUnique.mockResolvedValue({ id: 42 });

    const result = await toggleSectionMute({ entityType: 'image', entityId: 5, userId: 7 });

    expect(db.threadMute.deleteMany).toHaveBeenCalledWith({ where: { threadId: 42, userId: 7 } });
    expect(db.threadMute.create).toHaveBeenCalledWith({ data: { threadId: 42, userId: 7 } });
    expect(result).toEqual({ muted: true, threadId: 42 });
  });
});

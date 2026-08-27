import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { toggleThreadMute } from '../commentsv2.service';

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
      select: { threadId: true, childThread: { select: { id: true } } },
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
    db.thread.create.mockResolvedValue({ id: 99 });

    const result = await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { commentId: 5, parentThreadId: 10, rootThreadId: 3 },
      })
    );
    expect(result).toEqual({ muted: true, threadId: 99 });
  });

  it('roots a lazily created thread at its parent when the parent IS the root', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue({ id: 10, rootThreadId: null });
    db.thread.create.mockResolvedValue({ id: 99 });

    await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { commentId: 5, parentThreadId: 10, rootThreadId: 10 },
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

  it('refuses a comment that does not exist', async () => {
    db.commentV2.findUnique.mockResolvedValue(null);

    await expect(toggleThreadMute({ commentId: 5, userId: 1 })).rejects.toThrow(
      /could not find entity/i
    );
    expect(db.threadMute.create).not.toHaveBeenCalled();
  });
});

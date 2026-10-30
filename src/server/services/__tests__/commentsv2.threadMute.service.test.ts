import type * as KyselyDb from '~/server/db/kyselyDb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const kysely = vi.hoisted(() => {
  const state = {
    calls: [] as { table: string; where: unknown[][] }[],
    answers: [] as unknown[],
  };
  const selectFrom = (table: string) => {
    const call = { table, where: [] as unknown[][] };
    state.calls.push(call);
    const query = {
      select: () => query,
      where: (...a: unknown[]) => {
        call.where.push(a);
        return query;
      },
      executeTakeFirst: async () =>
        state.answers.length > 1 ? state.answers.shift() : state.answers[0],
    };
    return query;
  };
  return { state, selectFrom };
});
vi.mock('~/server/db/kyselyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof KyselyDb>()),
  kyselyRead: { selectFrom: kysely.selectFrom },
}));

import { sectionMuteSchema } from '~/server/schema/commentv2.schema';
import {
  getSectionMuted,
  getThreadMuted,
  toggleSectionMute,
  toggleThreadMute,
} from '../commentsv2.service';
import { notCommentMuted } from '~/server/notifications/base.notifications';

/**
 * Muting a comment's thread can run before that thread exists — a comment's reply thread is created
 * lazily by the first reply. The row this creates is the SAME row `upsertComment` would have created,
 * and it must carry the same ancestry, because the reply path finds it and skips its own create.
 */

const db = dbMock.dbWrite;

beforeEach(() => {
  kysely.state.calls.length = 0;
  kysely.state.answers = [undefined];
  vi.clearAllMocks();
  db.threadMute.deleteMany.mockResolvedValue({ count: 0 });
  db.threadMute.createMany.mockResolvedValue({ count: 1 });
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

    expect(db.thread.upsert).not.toHaveBeenCalled();
    expect(db.threadMute.createMany).toHaveBeenCalledWith({
      data: [{ threadId: 77, userId: 1 }],
      skipDuplicates: true,
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

  it('falls back to the comment own thread when the parent row has vanished', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue(null);
    db.thread.upsert.mockResolvedValue({ id: 99 });
    db.$queryRaw.mockResolvedValue([{ locked: false, unresolved: false }]);

    await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.thread.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { commentId: 5, parentThreadId: 10, rootThreadId: 10 },
      })
    );
  });

  it('unmutes when a mute row already existed, and writes no new one', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    db.threadMute.deleteMany.mockResolvedValue({ count: 1 });

    const result = await toggleThreadMute({ commentId: 5, userId: 1 });

    expect(db.threadMute.createMany).not.toHaveBeenCalled();
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
    expect(db.threadMute.createMany).not.toHaveBeenCalled();
    expect(db.threadMute.deleteMany).not.toHaveBeenCalled();
  });

  it('consults the thread-lock chain before creating a reply thread', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.thread.findUnique.mockResolvedValue({ id: 10, rootThreadId: 3 });
    db.thread.upsert.mockResolvedValue({ id: 99 });
    db.$queryRaw.mockResolvedValue([{ locked: false, unresolved: false }]);

    await toggleThreadMute({ commentId: 5, userId: 1 });

    // Destructuring only the strings array drops every interpolated value, so a swap to
    // `throwIfThreadChainLocked(commentId)` would walk an unrelated chain and still pass. The tag
    // records values in the same call, so assert on the whole call.
    const [call] = db.$queryRaw.mock.calls;
    expect(call[0].join('?')).toContain('RECURSIVE chain');
    expect(call).toContain(10);
    expect(call).not.toContain(5);
  });

  it('refuses to create a reply thread inside a locked chain', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    db.$queryRaw.mockResolvedValue([{ locked: true, unresolved: false }]);

    await expect(toggleThreadMute({ commentId: 5, userId: 1 })).rejects.toThrow(/locked/i);
    expect(db.thread.upsert).not.toHaveBeenCalled();
    expect(db.threadMute.createMany).not.toHaveBeenCalled();
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
    expect(db.threadMute.createMany).not.toHaveBeenCalled();
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

    // NOT asserting `thread.create`/`thread.upsert` were not called: `toggleSectionMute` has no
    // create call site on any path, so those negatives are true for every input and would pass a
    // refactor that added one under a different condition. The two below can actually fail.
    expect(db.threadMute.createMany).not.toHaveBeenCalled();
    expect(db.thread.findUnique).toHaveBeenCalled();
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
    expect(db.threadMute.createMany).toHaveBeenCalledWith({
      data: [{ threadId: 42, userId: 7 }],
      skipDuplicates: true,
    });
    expect(result).toEqual({ muted: true, threadId: 42 });
  });
});

/**
 * The READ half. It had no tests at all, in a file named for the feature — so coverage of the two
 * toggles read as coverage of the whole thing, and every mutation below left the suite green.
 */
describe('getThreadMuted', () => {
  const walk = (
    rows: { own: boolean | null; ancestor: boolean | null; locked?: boolean | null }[]
  ) => dbMock.dbWrite.$queryRaw.mockResolvedValue(rows);

  /**
   * The select is what lets `canMute` see a reply thread and the ToS refusal fire, and a mocked
   * client ignores it — the write-side test two describes up exists for exactly this.
   */
  it('reads the child thread canMute depends on, and the ToS flag', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([{ own: true, ancestor: false }]);

    await getThreadMuted({ commentId: 5, userId: 1 });

    expect(dbMock.dbRead.commentV2.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { tosViolation: true, childThread: { select: { id: true } } },
    });
  });

  /**
   * The menu has to read the predicate the notification suppression reads, or the label and the
   * notification disagree. Asserted on the statement, because the mock answers whatever SQL it is
   * handed: a hand-written copy of the predicate would pass every row-mocking test below.
   */
  it('reads the suppression predicate itself, keyed on this comment and this caller', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([{ own: true, ancestor: false }]);

    await getThreadMuted({ commentId: 5, userId: 42 });

    const [call] = dbMock.dbWrite.$queryRaw.mock.calls;
    const [predicate, ...values] = call.slice(1) as [{ sql: string }, ...number[]];
    expect(predicate.sql).toBe(notCommentMuted('u.id', 'c'));
    // Caller first, comment second: swapped, a mute set by user 5 on comment 42 would answer.
    expect(values).toEqual([42, 5]);
    // What the statement does with them runs against Postgres in comment-v3-readers.sql.behavior.
  });

  /**
   * What a comment with no CommentV3 row yields: no row at all. Both `?? false` defaults could be
   * flipped to `?? true` with the suite green.
   */
  it('reports not-muted for a comment with no CommentV3 row', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([]);

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: false,
      viaAncestor: false,
      canMute: true,
    });
  });

  it('reports a mute set on the comment own thread as its own, not inherited', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([{ own: true, ancestor: true }]);

    // Holding BOTH is ordinary: mute a comment, then mute the whole discussion. `own` wins, because
    // this user has a row of their own to remove.
    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: true,
      viaAncestor: false,
      canMute: true,
    });
  });

  it('reports a mute set above as inherited, so the menu can refuse a no-op unmute', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([{ own: false, ancestor: true }]);

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: true,
      viaAncestor: true,
      canMute: true,
    });
  });

  /**
   * The bug this pair exists for: a reply thread is created lazily, so a comment nobody has replied
   * to has none — and returning early there reported "not muted" on most comments inside a muted
   * discussion while notifications were correctly suppressed.
   */
  it('reports an ancestor mute on a comment nobody has replied to', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    walk([{ own: false, ancestor: true, locked: false }]);

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: true,
      viaAncestor: true,
      // No reply thread, but the chain is unlocked, so the create would succeed.
      canMute: true,
    });
  });

  /**
   * The case the client's `isLocked` could not see: a drilled-in or deep-linked thread has no React
   * ancestor, so that flag is false even when the root is locked. Muting here has to create a reply
   * thread, which `throwIfThreadChainLocked` refuses, so the server has to say so.
   */
  it('refuses a reply-less comment whose chain is locked further up', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: null });
    walk([{ own: false, ancestor: false, locked: true }]);

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: false,
      viaAncestor: false,
      canMute: false,
    });
  });

  it('still allows muting a thread that exists, even inside a locked chain', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({ threadId: 10, childThread: { id: 77 } });
    walk([{ own: false, ancestor: false, locked: true }]);

    // Nothing is created, so the lock is not in the way — muting an existing thread stays allowed.
    expect((await getThreadMuted({ commentId: 5, userId: 1 })).canMute).toBe(true);
  });

  it('refuses a ToS-removed comment rather than answering about it', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue({
      threadId: 10,
      tosViolation: true,
      childThread: { id: 77 },
    });

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: false,
      viaAncestor: false,
      canMute: false,
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports nothing for a comment that does not exist, without walking', async () => {
    dbMock.dbRead.commentV2.findUnique.mockResolvedValue(null);

    expect(await getThreadMuted({ commentId: 5, userId: 1 })).toEqual({
      muted: false,
      viaAncestor: false,
      canMute: false,
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('getSectionMuted', () => {
  // Same reason as the toggle's table: the mock ignores `where`, so a hardcoded `imageId` passes
  // every other assertion. Two types, because one cannot tell a hardcoded key from a computed one.
  it.each([
    ['post', 'postId'],
    ['article', 'articleId'],
  ] as const)('resolves the %s section by its own column', async (entityType, column) => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: 42 });
    kysely.state.answers = [undefined];

    await getSectionMuted({ entityType, entityId: 5, userId: 7 });

    expect(dbMock.dbRead.thread.findUnique).toHaveBeenCalledWith({
      where: { [column]: 5 },
      select: { id: true },
    });
  });

  it('distinguishes "nothing to mute yet" from "not muted"', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue(null);

    expect(await getSectionMuted({ entityType: 'image', entityId: 5, userId: 1 })).toEqual({
      muted: false,
      hasThread: false,
    });
  });

  it('reports a section that exists and is not muted', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: 42 });
    kysely.state.answers = [undefined];

    expect(await getSectionMuted({ entityType: 'image', entityId: 5, userId: 1 })).toEqual({
      muted: false,
      hasThread: true,
    });
  });

  it('scopes the lookup to the caller', async () => {
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: 42 });
    kysely.state.answers = [{ userId: 7 }];

    const result = await getSectionMuted({ entityType: 'image', entityId: 5, userId: 7 });

    const [lookup] = kysely.state.calls;
    expect(lookup.table).toBe('CommentTopicMute');
    expect(lookup.where).toEqual([
      ['userId', '=', 7],
      ['entityType', '=', 'image'],
      ['entityId', '=', 5],
    ]);
    expect(result).toEqual({ muted: true, hasThread: true });
  });

  it('answers not-muted for a retired thread type that has no topic, without a lookup', async () => {
    // `question` is a valid section type but not a CommentEntityType; casting it would fail the query.
    dbMock.dbRead.thread.findUnique.mockResolvedValue({ id: 42 });

    expect(await getSectionMuted({ entityType: 'question', entityId: 5, userId: 7 })).toEqual({
      muted: false,
      hasThread: true,
    });
    expect(kysely.state.calls).toHaveLength(0);
  });
});

/**
 * The exclusion is the only thing between the comics page and a 500 — `Thread` has no
 * `comicChapterId`, comic threads hang off `@@unique([comicProjectId, comicChapterPosition])`, and
 * `ChapterComments` supplies `comicChapter` to the same context the control reads. Deleting the
 * `.exclude(...)` used to fail nothing.
 */
describe('sectionMuteSchema', () => {
  it.each(['comicChapter', 'comment'])('refuses %s, which has no single unique column', (type) => {
    expect(sectionMuteSchema.safeParse({ entityType: type, entityId: 1 }).success).toBe(false);
  });

  // The positive control: without it the test above passes for a schema that refuses everything.
  it.each(['image', 'post', 'article', 'model3d'])('accepts %s', (type) => {
    expect(sectionMuteSchema.safeParse({ entityType: type, entityId: 1 }).success).toBe(true);
  });
});

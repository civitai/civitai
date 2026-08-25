import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { upsertComment } from '../commentsv2.service';

/**
 * `upsertComment` must read the thread lock from the row it is about to write, never from the
 * request's `entityType`/`entityId` — those are client-supplied and the update is scoped by comment
 * id alone, so a request naming an unlocked thread would otherwise decide whether a locked one is
 * enforced. A lock also covers the threads nested under it, because a reply lives in a child thread
 * of its own and a moderator only ever locks the one row.
 */

const db = dbMock.dbWrite;

type FakeThread = {
  locked?: boolean;
  /** The thread holding the comment this one hangs off — the `Thread.commentId` link, walked up. */
  parent?: number;
  /** False models an ORPHAN: no parent comment and no entity, which the guard must refuse. */
  rooted?: boolean;
};

/**
 * Stands in for the recursive walk, and models the SAME three outcomes the SQL does rather than
 * keying on the seed id alone: a fake that only answers "is this id locked" cannot tell a
 * self-lock from an ancestor lock, and every ancestor assertion written against it would pass for
 * the wrong reason.
 */
let threads: Map<number, FakeThread>;
/** The thread ids the walk was seeded with, in call order. */
let lockQueriedThreadIds: number[];
/** Every walk query the service issued, so its shape can be asserted. */
let queriedSql: string[];

const MAX_DEPTH = 100;

function walk(seed: number) {
  let current: number | undefined = seed;
  let depth = 0;
  while (current != null && depth < MAX_DEPTH) {
    const node: FakeThread | undefined = threads.get(current);
    depth += 1;
    if (!node) return { locked: false, unresolved: true };
    if (node.locked) return { locked: true, unresolved: false };
    if (node.parent == null) return { locked: false, unresolved: node.rooted === false };
    current = node.parent;
  }
  return { locked: false, unresolved: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  threads = new Map();
  lockQueriedThreadIds = [];
  queriedSql = [];

  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (!sql.includes('RECURSIVE chain')) return [];
    queriedSql.push(sql);
    const seed = values.find((v) => typeof v === 'number') as number;
    lockQueriedThreadIds.push(seed);
    return [walk(seed)];
  });
  db.commentV2.update.mockResolvedValue({ id: 5 });
  db.commentV2.create.mockResolvedValue({ id: 999 });
  db.thread.create.mockResolvedValue({
    id: 100,
    locked: false,
    rootThreadId: null,
    parentThreadId: null,
  });
});

const base = {
  userId: 7,
  entityType: 'image',
  entityId: 1,
  content: 'hello',
} as Parameters<typeof upsertComment>[0];

const edit = (over: Record<string, unknown> = {}) =>
  upsertComment({ ...base, id: 5, ...over } as Parameters<typeof upsertComment>[0]);

describe('upsertComment — thread lock on edit', () => {
  beforeEach(() => {
    // The comment being edited lives on thread 42. The same read serves the sticker charge, hence
    // both fields.
    db.commentV2.findUnique.mockResolvedValue({ threadId: 42, content: 'old' });
  });

  it('refuses the edit when the comment thread is locked, whatever entity the request names', async () => {
    threads.set(42, { locked: true, rooted: true });
    // An unlocked thread, named by the request. Before the fix this decided the outcome.
    db.thread.findUnique.mockResolvedValue({ id: 7, locked: false });

    await expect(edit({ entityType: 'post', entityId: 999 })).rejects.toThrow(
      'comment thread locked'
    );

    expect(lockQueriedThreadIds).toEqual([42]);
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });

  it('refuses the edit when an ANCESTOR thread is locked and the comment thread is not', async () => {
    threads.set(42, { locked: false, parent: 8 });
    threads.set(8, { locked: true, rooted: true });

    await expect(edit()).rejects.toThrow('comment thread locked');
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });

  it('allows an ordinary edit when nothing in the chain is locked', async () => {
    threads.set(42, { locked: false, parent: 8 });
    threads.set(8, { locked: false, rooted: true });

    await expect(edit()).resolves.toMatchObject({ id: 5 });
    expect(lockQueriedThreadIds).toEqual([42]);
    expect(db.commentV2.update).toHaveBeenCalledTimes(1);
  });

  it('refuses when the chain cannot be resolved to an entity, and says so distinctly', async () => {
    // An orphan: the parent comment was deleted, so `Thread.commentId` was nulled and the walk has
    // no path back to the entity. That is not proof nothing above it is locked.
    threads.set(42, { locked: false, rooted: false });

    await expect(edit()).rejects.toThrow('comment thread is no longer available');
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });

  it('does not exempt a moderator', async () => {
    threads.set(42, { locked: true, rooted: true });

    await expect(edit({ isModerator: true })).rejects.toThrow('comment thread locked');
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });
});

describe('upsertComment — thread lock on create', () => {
  it('refuses a new comment in a locked thread', async () => {
    threads.set(9, { locked: true, rooted: true });
    db.thread.findUnique.mockResolvedValue({ id: 9, locked: true });

    await expect(upsertComment({ ...base })).rejects.toThrow('comment thread locked');
    expect(lockQueriedThreadIds).toEqual([9]);
    expect(db.commentV2.create).not.toHaveBeenCalled();
  });

  it('allows a new comment in an unlocked thread', async () => {
    threads.set(9, { locked: false, rooted: true });
    db.thread.findUnique.mockResolvedValue({ id: 9, locked: false });

    await expect(upsertComment({ ...base })).resolves.toMatchObject({ id: 999 });
    expect(db.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a first reply under a locked thread, before its own thread row exists', async () => {
    // No thread hangs off the parent comment yet, so the ancestors have to be walked from the
    // parent comment's own thread instead.
    db.thread.findUnique.mockResolvedValue(null);
    db.commentV2.findUnique.mockResolvedValue({ threadId: 5, content: '' });
    threads.set(5, { locked: true, rooted: true });

    await expect(
      upsertComment({ ...base, entityType: 'comment', entityId: 3 } as Parameters<
        typeof upsertComment
      >[0])
    ).rejects.toThrow('comment thread locked');

    expect(lockQueriedThreadIds).toEqual([5]);
    expect(db.commentV2.create).not.toHaveBeenCalled();
  });

  it('allows a first reply when nothing above it is locked', async () => {
    db.thread.findUnique.mockResolvedValue(null);
    db.commentV2.findUnique.mockResolvedValue({ threadId: 5, content: '' });
    threads.set(5, { locked: false, rooted: true });

    await expect(
      upsertComment({ ...base, entityType: 'comment', entityId: 3 } as Parameters<
        typeof upsertComment
      >[0])
    ).resolves.toMatchObject({ id: 999 });
    expect(db.commentV2.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * The fake above substitutes for the whole query, so no other test here can see the SQL. This pins
 * the one thing about it that would be silently wrong rather than loudly wrong.
 *
 * To whoever is about to delete this: the walk goes UP. Reversing either join makes it descend into
 * replies instead, which finds no lock on any nested comment and reports a clean chain — the exact
 * shape of the bug this file exists to prevent, with every behavioural test above still green.
 */
describe('the chain walk resolves upward', () => {
  it('joins a thread to its parent comment and that comment to its thread', async () => {
    db.commentV2.findUnique.mockResolvedValue({ threadId: 42, content: 'old' });
    threads.set(42, { locked: false, rooted: true });

    await edit();

    expect(queriedSql).toHaveLength(1);
    expect(queriedSql[0]).toContain('JOIN "CommentV2" pc ON pc.id = c."commentId"');
    expect(queriedSql[0]).toContain('JOIN "Thread" p ON p.id = pc."threadId"');
  });
});

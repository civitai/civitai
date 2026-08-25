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

/** The thread ids the lock query was actually asked about, in call order. */
let lockQueriedThreadIds: number[] = [];
/** Thread ids whose chain the fake reports as locked. */
let lockedChains = new Set<number>();

function isLockQuery(strings: TemplateStringsArray) {
  return strings.join('').includes('RECURSIVE chain');
}

beforeEach(() => {
  vi.clearAllMocks();
  lockQueriedThreadIds = [];
  lockedChains = new Set();

  db.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!isLockQuery(strings)) return [];
    const threadId = values[0] as number;
    lockQueriedThreadIds.push(threadId);
    return lockedChains.has(threadId) ? [{ id: threadId }] : [];
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

describe('upsertComment — thread lock on edit', () => {
  beforeEach(() => {
    // The comment being edited lives on thread 42. The same read serves the previous-content
    // lookup on the edit path, hence both fields.
    db.commentV2.findUnique.mockResolvedValue({ threadId: 42, content: 'old' });
  });

  it('refuses the edit when the comment thread is locked, whatever entity the request names', async () => {
    lockedChains.add(42);
    // An unlocked thread, named by the request. Before the fix this decided the outcome.
    db.thread.findUnique.mockResolvedValue({ id: 7, locked: false });

    await expect(
      upsertComment({ ...base, id: 5, entityType: 'post', entityId: 999 } as Parameters<
        typeof upsertComment
      >[0])
    ).rejects.toThrow('comment thread locked');

    expect(lockQueriedThreadIds).toEqual([42]);
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });

  it('allows an ordinary edit when the comment thread is not locked', async () => {
    db.thread.findUnique.mockResolvedValue({ id: 42, locked: false });

    await expect(
      upsertComment({ ...base, id: 5 } as Parameters<typeof upsertComment>[0])
    ).resolves.toMatchObject({ id: 5 });

    expect(lockQueriedThreadIds).toEqual([42]);
    expect(db.commentV2.update).toHaveBeenCalledTimes(1);
  });

  it('refuses the edit when an ancestor thread is locked', async () => {
    // The chain walk is what reports this: thread 42 itself is not locked, its root is.
    lockedChains.add(42);
    db.thread.findUnique.mockResolvedValue({ id: 42, locked: false });

    await expect(
      upsertComment({ ...base, id: 5 } as Parameters<typeof upsertComment>[0])
    ).rejects.toThrow('comment thread locked');
    expect(db.commentV2.update).not.toHaveBeenCalled();
  });
});

describe('upsertComment — thread lock on create', () => {
  it('refuses a new comment in a locked thread', async () => {
    lockedChains.add(9);
    db.thread.findUnique.mockResolvedValue({ id: 9, locked: true });

    await expect(upsertComment({ ...base })).rejects.toThrow('comment thread locked');
    expect(lockQueriedThreadIds).toEqual([9]);
    expect(db.commentV2.create).not.toHaveBeenCalled();
  });

  it('allows a new comment in an unlocked thread', async () => {
    db.thread.findUnique.mockResolvedValue({ id: 9, locked: false });

    await expect(upsertComment({ ...base })).resolves.toMatchObject({ id: 999 });
    expect(db.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a first reply under a locked thread, before its own thread row exists', async () => {
    // No thread hangs off the parent comment yet, so the ancestors have to be walked from the
    // parent comment's own thread instead.
    db.thread.findUnique.mockResolvedValue(null);
    db.commentV2.findUnique.mockResolvedValue({ threadId: 5, content: '' });
    lockedChains.add(5);

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

    await expect(
      upsertComment({ ...base, entityType: 'comment', entityId: 3 } as Parameters<
        typeof upsertComment
      >[0])
    ).resolves.toMatchObject({ id: 999 });
    expect(db.commentV2.create).toHaveBeenCalledTimes(1);
  });
});

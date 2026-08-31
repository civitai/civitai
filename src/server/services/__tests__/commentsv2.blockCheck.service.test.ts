import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * upsertComment (CommentsV2 service) must enforce user-blocking on BOTH branches:
 * a user blocked by the content owner can neither add a comment nor edit one they
 * wrote before the block — an edit can replace the content wholesale, so guarding
 * only creates left the block trivially bypassable.
 */

const { amIBlockedByUser, throwOnBlockedCommentContent, tx } = vi.hoisted(() => ({
  amIBlockedByUser: vi.fn(async (..._a: unknown[]): Promise<boolean> => false),
  throwOnBlockedCommentContent: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
  // 🔴 `tx` stays a SEPARATE object from the write client, because every assertion below is
  // on `db.tx.*` and means "written inside the transaction". Inheriting the canonical
  // `$transaction` would hand the callback `dbMock.dbWrite` and collapse the two, so an
  // in-transaction create would start satisfying an assertion about a direct one.
  tx: {
    thread: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 100, locked: false })),
    },
    commentV2: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 999 })),
      // The edit path now runs inside the caller's transaction, so the sticker
      // charge and the comment write commit together.
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 5 })),
    },
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    $executeRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => 0),
  },
}));

// One local served both clients and hid a genuine split. `upsertComment` resolves the content
// owner through `getThreadEntityOwnerId`, which reads `image` on dbRead (commentsv2.service:172);
// its own thread lookup (:267) and the previous-content read on the edit path (:279) are dbWrite.
// The edit-path block check reads the stored comment on dbRead — a THIRD split, and the reason
// `commentV2` appears here twice.
const db = {
  tx,
  image: dbMock.dbRead.image,
  thread: dbMock.dbWrite.thread,
  commentV2: dbMock.dbWrite.commentV2,
  readCommentV2: dbMock.dbRead.commentV2,
  challenge: dbMock.dbRead.challenge,
};

db.image.findUnique.mockResolvedValue({ userId: 100 });
db.commentV2.findUnique.mockResolvedValue({ content: '' });
// The comment being edited lives on a top-level thread hanging off the image owned by 100.
db.readCommentV2.findUnique.mockResolvedValue({
  thread: { commentId: null, rootThreadId: null, imageId: 1 },
});
dbMock.dbWrite.$transaction.mockImplementation(async (cb: (t: typeof tx) => Promise<unknown>) =>
  cb(tx)
);

vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedCommentContent }));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

import { upsertComment } from '../commentsv2.service';

const baseCreate = {
  userId: 7,
  entityType: 'image',
  entityId: 1,
  content: 'hello',
} as Parameters<typeof upsertComment>[0];

beforeEach(() => {
  vi.clearAllMocks();
  amIBlockedByUser.mockResolvedValue(false);
  throwOnBlockedCommentContent.mockResolvedValue(undefined);
});

/**
 * The blocklist guard is wired at exactly three call sites and mocked in every suite that
 * reaches one, so nothing observed that the wiring existed: deleting the call in
 * `commentsv2.service.ts`, or hardcoding `{ isModerator: true }`, left the whole workspace
 * green. That second mutation is the production state 868kw2f8y was filed about.
 *
 * These assert the CALL, which is the only thing a mocked guard can pin.
 */
describe('upsertComment - blocklist guard wiring', () => {
  it('runs the guard once, passing the author moderator flag', async () => {
    await upsertComment({ ...baseCreate });
    expect(throwOnBlockedCommentContent).toHaveBeenCalledTimes(1);
    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('hello', { isModerator: undefined });
  });

  it('forwards a moderator through to the guard rather than deciding locally', async () => {
    await upsertComment({ ...baseCreate, isModerator: true } as Parameters<
      typeof upsertComment
    >[0]);
    expect(throwOnBlockedCommentContent).toHaveBeenCalledWith('hello', { isModerator: true });
  });

  // Ordering, which nothing else pins: a guard that ran AFTER the write would leave the
  // phishing comment in the table and merely fail the request.
  it('rejects before writing anything when the guard throws', async () => {
    throwOnBlockedCommentContent.mockRejectedValueOnce(new Error('blocked'));
    await expect(upsertComment({ ...baseCreate })).rejects.toThrow('blocked');
    expect(db.tx.commentV2.create).not.toHaveBeenCalled();
  });

  it('rejects before writing anything on the edit path too', async () => {
    throwOnBlockedCommentContent.mockRejectedValueOnce(new Error('blocked'));
    await expect(
      upsertComment({ ...baseCreate, id: 5 } as Parameters<typeof upsertComment>[0])
    ).rejects.toThrow('blocked');
    expect(db.tx.commentV2.update).not.toHaveBeenCalled();
  });
});

describe('upsertComment — block enforcement on create', () => {
  it('throws and never creates when the author is blocked by the content owner', async () => {
    amIBlockedByUser.mockResolvedValueOnce(true);
    await expect(upsertComment({ ...baseCreate })).rejects.toThrow();
    expect(db.tx.commentV2.create).not.toHaveBeenCalled();
  });

  it('allows a non-blocked author to create', async () => {
    await expect(upsertComment({ ...baseCreate })).resolves.toMatchObject({ id: 999 });
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: 7, targetUserId: 100 });
    expect(db.tx.commentV2.create).toHaveBeenCalledTimes(1);
  });

  it('exempts moderators from the block check', async () => {
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      upsertComment({ ...baseCreate, isModerator: true } as Parameters<typeof upsertComment>[0])
    ).resolves.toMatchObject({ id: 999 });
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });

  it('throws and never updates when a blocked author edits an existing comment', async () => {
    amIBlockedByUser.mockResolvedValue(true);
    await expect(
      upsertComment({ ...baseCreate, id: 5 } as Parameters<typeof upsertComment>[0])
    ).rejects.toThrow();
    expect(db.tx.commentV2.update).not.toHaveBeenCalled();
  });

  it('allows a non-blocked author to edit', async () => {
    await expect(
      upsertComment({ ...baseCreate, id: 5 } as Parameters<typeof upsertComment>[0])
    ).resolves.toMatchObject({ id: 5 });
    // The edit runs inside the transaction now, alongside the sticker charge.
    expect(db.tx.commentV2.update).toHaveBeenCalledTimes(1);
  });

  // The update is scoped by comment id alone — entityType/entityId are never checked against the
  // comment being edited. If the edit resolved its target from the request, a blocked user could
  // name an entity with no owner and edit freely; the check has to come from the stored comment.
  it('resolves an edit target from the comment, not the request', async () => {
    await upsertComment({
      ...baseCreate,
      id: 5,
      entityType: 'challenge',
      entityId: 999,
    } as Parameters<typeof upsertComment>[0]);

    // Reads the comment being edited...
    expect(db.readCommentV2.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } })
    );
    // ...and never resolves the entity the request named.
    expect(db.challenge.findUnique).not.toHaveBeenCalled();
  });
});

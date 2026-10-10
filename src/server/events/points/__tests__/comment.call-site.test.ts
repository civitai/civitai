import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as Award from '~/server/events/points/award';

// The CommentV2 write sites: a new comment awards, deleting the actor's last comment under an
// Image or Article removes (one at a time or in a moderator bulk delete), and a failing points
// call never fails the comment.

const { awardEventPoints, removeEventPoints, hatted } = vi.hoisted(() => ({
  awardEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  removeEventPoints: vi.fn(async (..._a: unknown[]) => undefined),
  hatted: new Set<string>(),
}));

vi.mock('~/server/events/points/award', async (importOriginal) => ({
  ...(await importOriginal<typeof Award>()),
  awardEventPoints,
  removeEventPoints,
  isHattedEntity: (entityType: string, entityId: number) => hatted.has(`${entityType}:${entityId}`),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedCommentContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/block-check.service', () => ({
  getBlockCheckOwnerIdsForComment: vi.fn(async () => []),
  getBlockCheckOwnerIdsForReply: vi.fn(async () => []),
  throwIfBlockedByEntityOwner: vi.fn(async () => undefined),
  throwIfBlockedByOwners: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/sticker.service', () => ({
  spendStickerUses: vi.fn(async () => []),
  recordStickerUsage: vi.fn(),
}));
vi.mock('~/server/services/text-scan/scam-scan-queue', () => ({ queueScamScan: vi.fn() }));

import {
  bulkDeleteCommentsV2,
  deleteComment,
  upsertComment,
} from '~/server/services/commentsv2.service';

const db = dbMock.dbWrite;
const USER = 5;
const IMAGE_THREAD = { id: 70, rootThreadId: null, imageId: 7, articleId: null, rootThread: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Resolves to 'pending' if `call` has not settled by the time pending microtasks drain.
const raceSettle = (call: Promise<unknown>) =>
  Promise.race([call.then(() => 'done'), settle().then(() => 'pending')]);

beforeEach(() => {
  vi.clearAllMocks();
  hatted.clear();
  hatted.add('Image:7');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db.thread.findUnique.mockResolvedValue(IMAGE_THREAD);
  db.thread.findMany.mockResolvedValue([IMAGE_THREAD]);
});

describe('CommentV2 event points', () => {
  it('awards a new comment on an image', async () => {
    db.commentV2.create.mockResolvedValue({ id: 456, threadId: 70 });

    await upsertComment({ userId: USER, entityType: 'image', entityId: 7, content: 'hi' });
    await settle();

    expect(awardEventPoints).toHaveBeenCalledWith([
      {
        type: 'comment',
        actorId: USER,
        entityType: 'Image',
        entityId: 7,
        time: expect.any(Date),
        sourceId: `CommentV2:Image:7:${USER}`,
      },
    ]);
  });

  it('is not failed by a failing points call', async () => {
    db.commentV2.create.mockResolvedValue({ id: 456, threadId: 70 });
    awardEventPoints.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      upsertComment({ userId: USER, entityType: 'image', entityId: 7, content: 'hi' })
    ).resolves.toMatchObject({ id: 456 });
    await settle();
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });

  it("removes when the deleted comment was the actor's last under the image", async () => {
    db.commentV2.delete.mockResolvedValue({ id: 456, userId: USER, threadId: 70 });
    db.commentV2.count.mockResolvedValue(0);

    await deleteComment({ id: 456 });
    await settle();

    expect(removeEventPoints).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'comment', sourceId: `CommentV2:Image:7:${USER}` }),
    ]);
  });

  it('removes for each author in a bulk delete, read before the rows go', async () => {
    db.commentV2.findMany.mockResolvedValue([
      { userId: USER, threadId: 70 },
      { userId: 6, threadId: 70 },
    ]);
    db.commentV2.deleteMany.mockResolvedValue({ count: 2 });
    db.commentV2.count.mockResolvedValue(0);

    await expect(bulkDeleteCommentsV2({ ids: [1, 2] })).resolves.toEqual({ count: 2 });
    await settle();

    // Read before the delete: after it, the rows (and so the authors) are gone.
    expect(db.commentV2.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      db.commentV2.deleteMany.mock.invocationCallOrder[0]
    );
    expect(db.commentV2.findMany.mock.calls[0][0]).toMatchObject({
      select: { userId: true, threadId: true },
    });

    expect(removeEventPoints.mock.calls.map(([[removal]]) => removal.sourceId)).toEqual([
      `CommentV2:Image:7:${USER}`,
      'CommentV2:Image:7:6',
    ]);
  });
});

describe('comment failure paths', () => {
  it('still deletes when the pre-delete read fails, and removes nothing', async () => {
    db.commentV2.findMany.mockRejectedValueOnce(new Error('read failed'));
    db.commentV2.deleteMany.mockResolvedValue({ count: 2 });

    await expect(bulkDeleteCommentsV2({ ids: [1, 2] })).resolves.toEqual({ count: 2 });
    await settle();
    expect(removeEventPoints).not.toHaveBeenCalled();
  });

  it('resolves while the points call is still pending', async () => {
    db.commentV2.create.mockResolvedValue({ id: 456, threadId: 70 });
    awardEventPoints.mockReturnValueOnce(new Promise(() => undefined));

    const call = upsertComment({ userId: USER, entityType: 'image', entityId: 7, content: 'hi' });
    expect(await raceSettle(call)).toBe('done');
    expect(awardEventPoints).toHaveBeenCalledTimes(1);
  });
});

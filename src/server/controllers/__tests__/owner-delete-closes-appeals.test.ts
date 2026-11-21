import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import type * as ReportService from '~/server/services/report.service';
import type * as Caches from '~/server/redis/caches';

// A post delete emits no per-image event, so the sweep cannot attribute it to the owner.

const { deleteImagesMock, deletePostMock, closeMock, pendingDeletionMock } = vi.hoisted(() => ({
  deleteImagesMock: vi.fn(),
  pendingDeletionMock: vi.fn(),
  deletePostMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  deleteImages: deleteImagesMock,
  imagesPendingDeletion: pendingDeletionMock,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  deletePost: deletePostMock,
}));
vi.mock('~/server/services/report.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportService>()),
  closeAppealsDeletedByOwner: closeMock,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  imageTagsCache: { fetch: vi.fn().mockResolvedValue({}) },
}));

import { deleteImageHandler } from '../image.controller';
import { deletePostHandler } from '../post.controller';
import { DELETE_PROCESSING_MESSAGE } from '~/shared/constants/delete-after-review.constants';

const ctx = (userId: number, isModerator = false) =>
  ({
    user: { id: userId, isModerator },
    track: { images: vi.fn(), post: vi.fn() },
  } as unknown as ProtectedContext);

beforeEach(() => {
  vi.clearAllMocks();
  closeMock.mockResolvedValue(undefined);
  pendingDeletionMock.mockResolvedValue(new Set());
});

describe('deleteImageHandler', () => {
  it("closes the deleter's pending appeals on the deleted image", async () => {
    // The image row names another owner: ownerId must still be the deleter.
    deleteImagesMock.mockResolvedValue([{ userId: 99, nsfwLevel: 1 }]);

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith({ entityType: 'Image', entityIds: [55], ownerId: 7 });
  });

  // Who deletes decides whether an object shop artwork still uses may be kept, whether every
  // version goes, and that a member's delete reaches only their own image: the actor alone says it.
  it.each([
    ['a member', false],
    ['a moderator', true],
  ])('tells the delete who is deleting, and nothing else: %s', async (_, isModerator) => {
    deleteImagesMock.mockResolvedValue([]);

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7, isModerator) });

    expect(deleteImagesMock).toHaveBeenCalledWith([55], { actor: { id: 7, isModerator } });
  });

  it("returns the deleted image's id and none of its moderation state", async () => {
    deleteImagesMock.mockResolvedValue([
      { id: 55, userId: 7, nsfwLevel: 1, url: 'k', needsReview: 'csam', blockedFor: 'CSAM' },
    ]);

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7, true) })).toEqual({
      id: 55,
    });
  });

  it('closes nothing when nothing was deleted', async () => {
    deleteImagesMock.mockResolvedValue([]);

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(closeMock).not.toHaveBeenCalled();
  });
});

// Decided with Legal and the product owner: a member's delete answers the same whether it went or
// any hold kept it, a review they can already see included (it lasts until the report is sent, so
// telling it apart would say when). Do not tell a kept delete apart here.
describe('deleteImageHandler, a delete a hold keeps', () => {
  it.each([
    ['a review its owner can see', new Set([55])],
    ['a hold with no notice of its own', new Set<number>()],
  ])('answers a delete kept by %s byte for byte like one that went', async (_, pending) => {
    deleteImagesMock.mockResolvedValue([]);
    pendingDeletionMock.mockResolvedValue(pending);
    const kept = await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });
    expect(closeMock).not.toHaveBeenCalled();

    deleteImagesMock.mockResolvedValue([{ id: 55, userId: 7, nsfwLevel: 1 }]);
    const went = await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(JSON.stringify(kept)).toBe(JSON.stringify(went));
    expect(went).toEqual({ deleteNotice: DELETE_PROCESSING_MESSAGE });
  });

  it("answers a moderator's delete with the deleted id", async () => {
    deleteImagesMock.mockResolvedValue([{ id: 55, userId: 7, nsfwLevel: 1 }]);
    pendingDeletionMock.mockResolvedValue(new Set([55]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(9, true) })).toEqual({ id: 55 });
  });

  it('tells a moderator their kept delete waits on a review the owner can see', async () => {
    deleteImagesMock.mockResolvedValue([]);
    pendingDeletionMock.mockResolvedValue(new Set([55]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(9, true) })).toEqual({
      deleteAfterReview: true,
    });
  });
});

describe('deletePostHandler', () => {
  it("closes the deleter's pending appeals on every image the delete removed", async () => {
    deletePostMock.mockResolvedValue({ id: 3, nsfwLevel: 1, deletedImageIds: [10, 11] });

    await deletePostHandler({ input: { id: 3 }, ctx: ctx(8) });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith({
      entityType: 'Image',
      entityIds: [10, 11],
      ownerId: 8,
    });
  });

  it.each([
    ['a member', false],
    ['a moderator', true],
  ])('tells the delete who is deleting: %s', async (_, isModerator) => {
    deletePostMock.mockResolvedValue(undefined);

    await deletePostHandler({ input: { id: 3 }, ctx: ctx(8, isModerator) });

    expect(deletePostMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { id: 8, isModerator } })
    );
  });

  it("tells the delete whether the deleter is a moderator, for a refusal's wording only", async () => {
    deletePostMock.mockResolvedValue(undefined);
    const mod = { ...ctx(9), user: { id: 9, isModerator: true } } as unknown as ProtectedContext;

    await deletePostHandler({ input: { id: 3 }, ctx: mod });

    const [args] = deletePostMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args.viewerIsModerator).toBe(true);
    expect(args.isModerator).toBeUndefined();
  });

  it('closes nothing when the post was not deleted', async () => {
    deletePostMock.mockResolvedValue(undefined);

    await deletePostHandler({ input: { id: 3 }, ctx: ctx(8) });

    expect(closeMock).not.toHaveBeenCalled();
  });

  it('answers a kept post byte for byte like one that went', async () => {
    deletePostMock.mockResolvedValue(undefined);
    const kept = await deletePostHandler({ input: { id: 3 }, ctx: ctx(8) });
    deletePostMock.mockResolvedValue({ id: 3, nsfwLevel: 1, deletedImageIds: [10] });
    const went = await deletePostHandler({ input: { id: 3 }, ctx: ctx(8) });

    expect(JSON.stringify(kept)).toBe(JSON.stringify(went));
    expect(went).toEqual({ deleteNotice: DELETE_PROCESSING_MESSAGE });
  });

  it('answers a post kept over a review its owner can see like any other, and closes and tracks nothing', async () => {
    deletePostMock.mockResolvedValue({ deleteAfterReview: true });
    const context = ctx(8);

    expect(await deletePostHandler({ input: { id: 3 }, ctx: context })).toEqual({
      deleteNotice: DELETE_PROCESSING_MESSAGE,
    });
    expect(closeMock).not.toHaveBeenCalled();
    expect(context.track.post).not.toHaveBeenCalled();
  });
});

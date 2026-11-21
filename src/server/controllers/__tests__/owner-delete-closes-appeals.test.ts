import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import type * as ReportService from '~/server/services/report.service';
import type * as Caches from '~/server/redis/caches';

// A post delete emits no per-image event, so the sweep cannot attribute it to the owner.

const { deleteImagesMock, deletePostMock, closeMock } = vi.hoisted(() => ({
  deleteImagesMock: vi.fn(),
  deletePostMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  deleteImagesWithOutcome: deleteImagesMock,
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

/** The delete's outcome: the rows it deleted, and the ids its child-safety case kept. */
const outcome = (deleted: unknown[], kept: { id: number; ownerTold: boolean }[] = []) => ({
  deleted,
  kept,
});

const ctx = (userId: number, isModerator = false) =>
  ({
    user: { id: userId, isModerator },
    track: { images: vi.fn(), post: vi.fn() },
  } as unknown as ProtectedContext);

beforeEach(() => {
  vi.clearAllMocks();
  closeMock.mockResolvedValue(undefined);
});

describe('deleteImageHandler', () => {
  it("closes the deleter's pending appeals on the deleted image", async () => {
    // The image row names another owner: ownerId must still be the deleter.
    deleteImagesMock.mockResolvedValue(outcome([{ userId: 99, nsfwLevel: 1 }]));

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
    deleteImagesMock.mockResolvedValue(outcome([]));

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7, isModerator) });

    expect(deleteImagesMock).toHaveBeenCalledWith([55], { actor: { id: 7, isModerator } });
  });

  it("returns the deleted image's id and none of its moderation state", async () => {
    deleteImagesMock.mockResolvedValue(
      outcome([
        { id: 55, userId: 7, nsfwLevel: 1, url: 'k', needsReview: 'csam', blockedFor: 'CSAM' },
      ])
    );

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) })).toEqual({ id: 55 });
  });

  it('closes nothing when nothing was deleted', async () => {
    deleteImagesMock.mockResolvedValue(outcome([]));

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(closeMock).not.toHaveBeenCalled();
  });
});

// Only a case the owner can already see is acknowledged; any other kept delete answers like a delete.
describe('deleteImageHandler, a delete that waits on a review', () => {
  it('answers with the notice when the kept image waits on a review its owner can see', async () => {
    deleteImagesMock.mockResolvedValue(outcome([], [{ id: 55, ownerTold: true }]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) })).toEqual({
      deleteAfterReview: true,
    });
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('answers like a delete when the review is one its owner cannot see', async () => {
    deleteImagesMock.mockResolvedValue(outcome([], [{ id: 55, ownerTold: false }]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) })).toBeNull();
  });

  it('tells a moderator their delete was kept, whatever the owner may see', async () => {
    deleteImagesMock.mockResolvedValue(outcome([], [{ id: 55, ownerTold: false }]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(9, true) })).toEqual({
      deleteAfterReview: true,
    });
  });

  it('answers with the deleted id when the image went', async () => {
    deleteImagesMock.mockResolvedValue(outcome([{ id: 55, userId: 7, nsfwLevel: 1 }]));

    expect(await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) })).toEqual({ id: 55 });
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

  it('passes on the notice for a kept post, and closes and tracks nothing', async () => {
    deletePostMock.mockResolvedValue({ deleteAfterReview: true });
    const context = ctx(8);

    expect(await deletePostHandler({ input: { id: 3 }, ctx: context })).toEqual({
      deleteAfterReview: true,
    });
    expect(closeMock).not.toHaveBeenCalled();
    expect(context.track.post).not.toHaveBeenCalled();
  });
});

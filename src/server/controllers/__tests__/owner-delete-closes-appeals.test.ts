import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProtectedContext } from '~/server/createContext';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import type * as ReportService from '~/server/services/report.service';
import type * as Caches from '~/server/redis/caches';

// A post delete emits no per-image event, so the sweep cannot attribute it to the owner.

const { deleteImageByIdMock, deletePostMock, closeMock } = vi.hoisted(() => ({
  deleteImageByIdMock: vi.fn(),
  deletePostMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  deleteImageById: deleteImageByIdMock,
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

const ctx = (userId: number) =>
  ({
    user: { id: userId, isModerator: false },
    track: { images: vi.fn(), post: vi.fn() },
  } as unknown as ProtectedContext);

beforeEach(() => {
  vi.clearAllMocks();
  closeMock.mockResolvedValue(undefined);
});

describe('deleteImageHandler', () => {
  it("closes the deleter's pending appeals on the deleted image", async () => {
    // The image row names another owner: ownerId must still be the deleter.
    deleteImageByIdMock.mockResolvedValue({ userId: 99, nsfwLevel: 1 });

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith({ entityType: 'Image', entityIds: [55], ownerId: 7 });
  });

  it('closes nothing when nothing was deleted', async () => {
    deleteImageByIdMock.mockResolvedValue(undefined);

    await deleteImageHandler({ input: { id: 55 }, ctx: ctx(7) });

    expect(closeMock).not.toHaveBeenCalled();
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

  it('closes nothing when the post was not deleted', async () => {
    deletePostMock.mockResolvedValue(undefined);

    await deletePostHandler({ input: { id: 3 }, ctx: ctx(8) });

    expect(closeMock).not.toHaveBeenCalled();
  });
});

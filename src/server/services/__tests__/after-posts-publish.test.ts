import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import type * as ImageService from '~/server/services/image.service';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks';

const postCountRefresh = vi.fn();
const imageVideoCountRefresh = vi.fn();
const queueImageSearchIndexUpdate = vi.fn();

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: postCountRefresh },
  userImageVideoCountCaches: { refresh: imageVideoCountRefresh },
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate,
}));

const { afterPostsPublish } = await import('~/server/services/post.service');

const findImages = dbMock.dbWrite.image.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  postCountRefresh.mockResolvedValue(undefined);
  imageVideoCountRefresh.mockResolvedValue(undefined);
  queueImageSearchIndexUpdate.mockResolvedValue(undefined);
  findImages.mockResolvedValue([{ id: 7 }, { id: 8 }, { id: 9 }]);
});

describe('afterPostsPublish', () => {
  it("reindexes every post's images and refreshes each owner's counts once", async () => {
    await afterPostsPublish([
      { postId: 300, userId: 10 },
      { postId: 301, userId: 11 },
      { postId: 302, userId: 10 },
    ]);

    expect(findImages).toHaveBeenCalledTimes(1);
    expect(findImages).toHaveBeenCalledWith({
      where: { postId: { in: [300, 301, 302] } },
      select: { id: true },
    });
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({
      ids: [7, 8, 9],
      action: SearchIndexUpdateQueueAction.Update,
    });
    expect(postCountRefresh).toHaveBeenCalledTimes(1);
    expect(postCountRefresh).toHaveBeenCalledWith([10, 11]);
    expect(imageVideoCountRefresh).toHaveBeenCalledTimes(1);
    expect(imageVideoCountRefresh).toHaveBeenCalledWith([10, 11]);
  });

  it('queues nothing for posts without images', async () => {
    findImages.mockResolvedValue([]);

    await afterPostsPublish([{ postId: 300, userId: 10 }]);

    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    expect(imageVideoCountRefresh).toHaveBeenCalledWith([10]);
  });

  it('touches nothing for an empty list', async () => {
    await afterPostsPublish([]);

    expect(findImages).not.toHaveBeenCalled();
    expect(postCountRefresh).not.toHaveBeenCalled();
    expect(imageVideoCountRefresh).not.toHaveBeenCalled();
  });
});

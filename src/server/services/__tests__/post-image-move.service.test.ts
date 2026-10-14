import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import type * as Metrics from '~/server/metrics';
import type * as Caches from '~/server/redis/caches';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { moveImagesToPost } from '~/server/services/post-image-move.service';
import { Availability, ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const mocks = vi.hoisted(() => ({
  createImageResources: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
  bustCachesForPosts: vi.fn(),
  updatePostNsfwLevel: vi.fn(),
  postMetricsQueueUpdate: vi.fn(),
  userPostCountRefresh: vi.fn(),
  preventReplicationLag: vi.fn(),
  bustCacheTag: vi.fn(),
}));

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  createImageResources: mocks.createImageResources,
  queueImageSearchIndexUpdate: mocks.queueImageSearchIndexUpdate,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  bustCachesForPosts: mocks.bustCachesForPosts,
  updatePostNsfwLevel: mocks.updatePostNsfwLevel,
}));
vi.mock('~/server/metrics', async (importOriginal) => ({
  ...(await importOriginal<typeof Metrics>()),
  postMetrics: { queueUpdate: mocks.postMetricsQueueUpdate },
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: mocks.userPostCountRefresh },
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  preventReplicationLag: mocks.preventReplicationLag,
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustCacheTag: mocks.bustCacheTag,
}));

const USER = 7;
const SOURCE_PUBLISHED = new Date('2026-01-01T00:00:00Z');
const postRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  userId: USER,
  publishedAt: SOURCE_PUBLISHED,
  tosViolation: false,
  isContest: false,
  modelVersionId: null,
  availability: Availability.Public,
  unlisted: false,
  ...over,
});
const imageRow = (id: number) => ({
  id,
  userId: USER,
  postId: 1,
  tosViolation: false,
  ingestion: ImageIngestionStatus.Scanned,
});

const db = dbMock.dbWrite;

function jobQueueInserts() {
  return db.$executeRaw.mock.calls
    .map((c: unknown[]) => (c[0] as TemplateStringsArray).join('?'))
    .filter((sql: string) => sql.includes('"JobQueue"'));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.image.findMany.mockResolvedValue([imageRow(100), imageRow(101)]);
  db.image.count.mockResolvedValue(3);
  db.image.aggregate.mockResolvedValue({ _max: { index: 4 } });
  db.post.create.mockResolvedValue({ id: 9 });
});

describe('moveImagesToPost', () => {
  it('repoints the images, appends them after the target images, and queues both posts', async () => {
    db.$queryRaw.mockResolvedValue([
      postRow(),
      postRow({ id: 2, publishedAt: new Date('2025-06-01'), modelVersionId: 55 }),
    ]);

    const result = await moveImagesToPost({
      imageIds: [101, 100],
      fromPostId: 1,
      toPostId: 2,
      userId: USER,
    });

    expect(result).toEqual({ postId: 2 });
    expect(db.image.update.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      { where: { id: 101 }, data: { postId: 2, index: 5 } },
      { where: { id: 100 }, data: { postId: 2, index: 6 } },
    ]);
    expect(db.post.create).not.toHaveBeenCalled();

    // UpdateNsfwLevel for both posts and CleanIfEmpty for the source, in one statement.
    expect(jobQueueInserts()).toHaveLength(1);
    const values = db.$executeRaw.mock.calls.find((c: unknown[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('"JobQueue"')
    );
    expect(JSON.stringify(values)).toContain('UpdateNsfwLevel');
    expect(JSON.stringify(values)).toContain('CleanIfEmpty');

    expect(mocks.updatePostNsfwLevel).toHaveBeenCalledWith([1, 2]);
    expect(mocks.bustCachesForPosts).toHaveBeenCalledWith([1, 2]);
    expect(mocks.postMetricsQueueUpdate).toHaveBeenCalledWith([1, 2]);
    expect(mocks.preventReplicationLag).toHaveBeenCalledWith('postImages', 1);
    expect(mocks.preventReplicationLag).toHaveBeenCalledWith('postImages', 2);
    expect(mocks.queueImageSearchIndexUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [101, 100] })
    );
    // Target is a showcase post, so each image gains that version as a resource.
    expect(mocks.createImageResources.mock.calls.map((c) => c[0])).toEqual([
      { imageId: 101 },
      { imageId: 100 },
    ]);
  });

  it('creates a new post at the source publish date and visibility when no target is given', async () => {
    db.$queryRaw.mockResolvedValue([
      postRow({ availability: Availability.Private, unlisted: true }),
    ]);
    db.image.findMany.mockResolvedValue([imageRow(100)]);
    db.image.aggregate.mockResolvedValue({ _max: { index: null } });

    const result = await moveImagesToPost({ imageIds: [100], fromPostId: 1, userId: USER });

    expect(result).toEqual({ postId: 9 });
    expect(db.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: USER, availability: Availability.Private, unlisted: true },
      })
    );
    expect(db.post.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { publishedAt: SOURCE_PUBLISHED },
    });
    expect(db.image.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { postId: 9, index: 0 },
    });
    expect(mocks.createImageResources).not.toHaveBeenCalled();
  });

  it('writes nothing when the move is refused', async () => {
    db.$queryRaw.mockResolvedValue([
      postRow(),
      postRow({ id: 2, publishedAt: new Date('2026-05-01') }),
    ]);

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER })
    ).rejects.toThrow(/published at the same time or earlier/);

    expect(db.image.update).not.toHaveBeenCalled();
    expect(db.post.create).not.toHaveBeenCalled();
    expect(jobQueueInserts()).toHaveLength(0);
    expect(mocks.updatePostNsfwLevel).not.toHaveBeenCalled();
  });

  it('refuses another user’s target post', async () => {
    db.$queryRaw.mockResolvedValue([
      postRow(),
      postRow({ id: 2, userId: 8, publishedAt: new Date('2025-06-01') }),
    ]);

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER })
    ).rejects.toThrow(/your own posts/);
    expect(db.image.update).not.toHaveBeenCalled();
  });
});

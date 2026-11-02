import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ImageService from '~/server/services/image.service';
import type * as PostService from '~/server/services/post.service';
import type * as Metrics from '~/server/metrics';
import type * as Caches from '~/server/redis/caches';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import { moveImagesToPost } from '~/server/services/post-image-move.service';
import { IMAGES_NOT_MOVABLE } from '~/server/services/post-image-move.rules';
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
  isChapter: false,
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
  needsReview: null,
});

const db = dbMock.dbWrite;

const accountRow = (over: Record<string, unknown> = {}) => ({
  report: false,
  'image-review': false,
  'image-blocked': false,
  'reported-image': false,
  markerView: false,
  markerTable: false,
  ...over,
});
// Nested Prisma.sql fragments (the lock clause) are values of the tagged call, so inline them.
const rawSql = ([strings, ...values]: unknown[]) =>
  (strings as TemplateStringsArray).reduce((sql, part, i) => {
    const value = values[i - 1] as { sql?: string } | undefined;
    return sql + (typeof value?.sql === 'string' ? value.sql : '?') + part;
  });
const isPostLock = (sql: string) => sql.includes('FOR UPDATE OF p');
const isVersionLock = (sql: string) => sql.includes('"ModelVersion"') && sql.includes('AS downed');

// Routed by statement: the account check, the split's version read and takedown lock, the posts.
function mockPosts(
  ...rows: (
    | ReturnType<typeof postRow>
    | { downed?: boolean; ownsModel?: boolean; readVersionId?: number | null }
  )[]
) {
  const posts = rows.filter((r): r is ReturnType<typeof postRow> => 'id' in r);
  const options = rows.find((r) => !('id' in r)) ?? {};
  const { downed = false, ownsModel = true } = options;
  // The version the split reads before the post lock; the source row's unless a test moves it.
  const readVersionId =
    'readVersionId' in options ? options.readVersionId : posts[0]?.modelVersionId;
  db.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (isPostLock(sql)) return Promise.resolve(posts);
    if (sql.includes('"ownsModel"'))
      return Promise.resolve(readVersionId ? [{ modelVersionId: readVersionId, ownsModel }] : []);
    if (sql.includes('AS downed')) return Promise.resolve([{ downed }]);
    return Promise.resolve([accountRow()]);
  }) as never);
}

function expectNothingWritten() {
  expect(db.image.updateMany).not.toHaveBeenCalled();
  expect(db.post.create).not.toHaveBeenCalled();
  expect(jobQueueInserts()).toHaveLength(0);
  expect(mocks.updatePostNsfwLevel).not.toHaveBeenCalled();
}

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
  db.image.updateMany.mockResolvedValue({ count: 1 });
});

describe('moveImagesToPost', () => {
  it('repoints the images, appends them after the target images, and queues both posts', async () => {
    mockPosts(
      postRow(),
      postRow({ id: 2, publishedAt: new Date('2025-06-01'), modelVersionId: 55 })
    );

    const result = await moveImagesToPost({
      imageIds: [101, 100],
      fromPostId: 1,
      toPostId: 2,
      userId: USER,
    });

    expect(result).toEqual({ postId: 2 });
    // The review refusal reads this field; a select without it would refuse every move.
    expect(db.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ needsReview: true }) })
    );
    expect(db.image.updateMany.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      {
        where: expect.objectContaining({ id: 101, postId: 1 }),
        data: { postId: 2, index: 5 },
      },
      {
        where: expect.objectContaining({ id: 100, postId: 1 }),
        data: { postId: 2, index: 6 },
      },
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
    mockPosts(postRow({ availability: Availability.Private, unlisted: true }));
    db.image.findMany.mockResolvedValue([imageRow(100)]);
    db.image.aggregate.mockResolvedValue({ _max: { index: null } });

    const result = await moveImagesToPost({ imageIds: [100], fromPostId: 1, userId: USER });

    expect(result).toEqual({ postId: 9 });
    expect(db.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          userId: USER,
          availability: Availability.Private,
          unlisted: true,
          modelVersionId: null,
        },
      })
    );
    expect(db.post.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { publishedAt: SOURCE_PUBLISHED },
    });
    expect(db.image.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 100 }),
      data: { postId: 9, index: 0 },
    });
    expect(mocks.createImageResources).not.toHaveBeenCalled();
  });

  it('gives a new post the source post’s model version and keeps the images’ resources', async () => {
    mockPosts(postRow({ modelVersionId: 55 }));

    await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER });

    expect(db.post.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ modelVersionId: 55 }) })
    );
    expect(db.imageResourceNew.deleteMany).not.toHaveBeenCalled();
  });

  it('locks the source version before the posts when it splits', async () => {
    mockPosts(postRow({ modelVersionId: 55 }));

    await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER });

    const sql = db.$queryRaw.mock.calls.map(rawSql);
    const versionLock = sql.findIndex((q: string) => isVersionLock(q) && q.includes('FOR SHARE'));
    expect(versionLock).toBeGreaterThanOrEqual(0);
    expect(versionLock).toBeLessThan(sql.findIndex(isPostLock));
  });

  it('refuses to split onto a taken-down version and writes nothing', async () => {
    mockPosts(postRow({ modelVersionId: 55 }), { downed: true });

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER })
    ).rejects.toThrow(/taken down/);
    expectNothingWritten();
  });

  it('reads the takedown without locking the version when the poster does not own the model', async () => {
    mockPosts(postRow({ modelVersionId: 55 }), { ownsModel: false });

    await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER });

    const reads = db.$queryRaw.mock.calls
      .map(rawSql)
      .filter((q: string) => q.includes('AS downed'));
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(q).not.toMatch(/FOR (SHARE|NO KEY UPDATE|UPDATE)/);
  });

  it("refuses a non-owner's split onto a taken-down version", async () => {
    mockPosts(postRow({ modelVersionId: 55 }), { ownsModel: false, downed: true });

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER })
    ).rejects.toThrow(/taken down/);
    expectNothingWritten();
  });

  it.each([
    ['another version', 55, 66],
    ['a version', null, 66],
    ['no version', 55, null],
  ])(
    'fails the split and writes nothing when the source moves to %s under the post lock',
    async (_, readVersionId, lockedVersionId) => {
      mockPosts(postRow({ modelVersionId: lockedVersionId }), { readVersionId });

      await expect(
        moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER })
      ).rejects.toThrow(/changed while moving/);
      expectNothingWritten();
    }
  );

  it.each([
    ['another version', 66],
    ['no version', null],
  ])(
    'drops only the source version’s undetected resource when the target has %s',
    async (_, targetVersionId) => {
      mockPosts(
        postRow({ modelVersionId: 55 }),
        postRow({ id: 2, publishedAt: new Date('2025-06-01'), modelVersionId: targetVersionId })
      );

      await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER });

      expect(db.imageResourceNew.deleteMany).toHaveBeenCalledTimes(1);
      expect(db.imageResourceNew.deleteMany).toHaveBeenCalledWith({
        where: { imageId: { in: [100, 101] }, modelVersionId: 55, detected: false },
      });
    }
  );

  it.each([
    ['the same version as the target', 55, 55],
    ['no version', null, 66],
  ])(
    'leaves the resources alone when the source has %s',
    async (_, sourceVersionId, targetVersionId) => {
      mockPosts(
        postRow({ modelVersionId: sourceVersionId }),
        postRow({ id: 2, publishedAt: new Date('2025-06-01'), modelVersionId: targetVersionId })
      );

      await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER });

      expect(db.imageResourceNew.deleteMany).not.toHaveBeenCalled();
    }
  );

  it('writes nothing when the move is refused', async () => {
    mockPosts(postRow(), postRow({ id: 2, publishedAt: new Date('2026-05-01') }));

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER })
    ).rejects.toThrow(/published at the same time or earlier/);
    expectNothingWritten();
  });

  it('refuses a restricted account, without saying why, and writes nothing', async () => {
    db.$queryRaw
      .mockResolvedValueOnce([accountRow({ report: true })])
      .mockResolvedValue([postRow()]);

    await expect(
      moveImagesToPost({ imageIds: [100], fromPostId: 1, userId: USER })
    ).rejects.toThrow(new RegExp(`^${IMAGES_NOT_MOVABLE}$`));
    expect(db.$transaction).not.toHaveBeenCalled();
    expectNothingWritten();
  });

  it('refuses when the account check cannot be read', async () => {
    db.$queryRaw
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValue([postRow()]);

    await expect(
      moveImagesToPost({ imageIds: [100], fromPostId: 1, userId: USER })
    ).rejects.toThrow(new RegExp(`^${IMAGES_NOT_MOVABLE}$`));
    expectNothingWritten();
  });

  it('moves some of a storyline chapter’s images', async () => {
    mockPosts(postRow({ isChapter: true }));
    db.image.count.mockResolvedValue(3);

    const result = await moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER });

    expect(result).toEqual({ postId: 9 });
    expect(db.image.count).toHaveBeenCalledWith({ where: { postId: 1 } });
    expect(db.image.updateMany).toHaveBeenCalledTimes(2);
  });

  it('fails the move when an image changed after it was checked', async () => {
    mockPosts(postRow());
    db.image.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER })
    ).rejects.toThrow(/changed while moving/);
    // The rollback on that throw is the database's; here, only that the write was conditional.
    expect(db.image.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          needsReview: null,
          ingestion: ImageIngestionStatus.Scanned,
          tosViolation: false,
          userId: USER,
        }),
      })
    );
    expect(mocks.updatePostNsfwLevel).not.toHaveBeenCalled();
  });

  it('refuses a move that would empty a storyline chapter', async () => {
    mockPosts(postRow({ isChapter: true }));
    db.image.count.mockResolvedValue(2);

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, userId: USER })
    ).rejects.toThrow(/storyline chapter/);
    expectNothingWritten();
  });

  it('refuses another user’s target post', async () => {
    mockPosts(postRow(), postRow({ id: 2, userId: 8, publishedAt: new Date('2025-06-01') }));

    await expect(
      moveImagesToPost({ imageIds: [100, 101], fromPostId: 1, toPostId: 2, userId: USER })
    ).rejects.toThrow(/your own posts/);
    expect(db.image.updateMany).not.toHaveBeenCalled();
  });
});

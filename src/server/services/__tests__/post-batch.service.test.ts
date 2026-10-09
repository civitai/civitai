import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PostController from '~/server/controllers/post.controller';
import type * as PostService from '~/server/services/post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as VisibilityService from '~/server/services/model-version-visibility.service';
import type { ProtectedContext } from '~/server/createContext';
import type { ScheduleBatchInput } from '~/server/schema/post.schema';

const { createPost, updatePost, addImage, removePost, addTools, addTechniques, canViewVersion } =
  vi.hoisted(() => ({
    createPost: vi.fn(),
    updatePost: vi.fn(),
    addImage: vi.fn(),
    removePost: vi.fn(),
    addTools: vi.fn(),
    addTechniques: vi.fn(),
    canViewVersion: vi.fn(),
  }));

vi.mock('~/server/services/post-schedule-lock', () => ({
  withPostScheduleLock: (_userId: number, operation: () => Promise<unknown>) => operation(),
}));
vi.mock('~/server/controllers/post.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof PostController>()),
  createPostHandler: createPost,
  updatePostHandler: updatePost,
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  addPostImage: addImage,
  deletePost: removePost,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  addImageTools: addTools,
  addImageTechniques: addTechniques,
}));
vi.mock('~/server/services/model-version-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof VisibilityService>()),
  canViewModelVersion: canViewVersion,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { scheduleBatch, validateBatchSchedule } from '~/server/services/post-batch.service';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const START_OF_TODAY_UTC = new Date('2026-10-01T00:00:00.000Z');
const HOUR = 3_600_000;
const at = (hoursFromNow: number, minute = 5) =>
  new Date(NOW.getTime() + hoursFromNow * HOUR + minute * 60_000);

const OWNER = { id: 7, isModerator: false, tier: 'free', meta: {} } as ProtectedContext['user'];
const MODERATOR = { ...OWNER, isModerator: true } as ProtectedContext['user'];
const ctxFor = (user = OWNER) =>
  ({
    user,
    ip: '127.0.0.1',
    track: { post: vi.fn() },
    features: {},
  } as unknown as ProtectedContext);

const image = (url: string) => ({ url, type: 'image' as const, meta: null, metadata: {} });
const batchOf = (
  dates: Date[],
  overrides: Partial<ScheduleBatchInput> = {}
): ScheduleBatchInput => ({
  modelVersionId: null,
  tags: [],
  tools: [],
  techniques: [],
  posts: dates.map((publishedAt, index) => ({
    title: `Post ${index + 1}`,
    publishedAt,
    images: [image(`${index}-a`), image(`${index}-b`)],
  })),
  ...overrides,
});

const existingPosts = (dates: Date[]) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue(dates.map((publishedAt) => ({ publishedAt })));

const nothingWritten = () => {
  expect(createPost).not.toHaveBeenCalled();
  expect(addImage).not.toHaveBeenCalled();
  expect(updatePost).not.toHaveBeenCalled();
  expect(removePost).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW });
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
  dbMock.dbWrite.modelVersion.findUnique.mockReset();
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({ id: 30, status: 'Published' });
  canViewVersion.mockResolvedValue(true);
  let nextPostId = 100;
  let nextImageId = 1000;
  createPost.mockImplementation(async () => ({ id: nextPostId++ }));
  addImage.mockImplementation(async () => ({ id: nextImageId++ }));
  updatePost.mockResolvedValue(undefined);
  removePost.mockResolvedValue(undefined);
  addTools.mockResolvedValue(undefined);
  addTechniques.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('validateBatchSchedule', () => {
  it('reads the creator’s posts from the start of today UTC on dbWrite, scoped by userId', async () => {
    existingPosts([at(1), at(26)]);

    const result = await validateBatchSchedule({
      input: { publishedAts: [at(2), at(27)] },
      user: OWNER,
    });

    expect(result).toEqual({
      ok: true,
      issues: [],
      dailyLimit: 20,
      perDay: [
        { day: '2026-10-01', existing: 1, incoming: 1 },
        { day: '2026-10-02', existing: 1, incoming: 1 },
      ],
    });
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toMatch(
      /SELECT "publishedAt" FROM "Post" WHERE "userId" = \? AND "publishedAt" >= \?/
    );
    expect(values).toEqual([7, START_OF_TODAY_UTC]);
  });

  it('reports the gap and the cap against existing posts', async () => {
    existingPosts(Array.from({ length: 20 }, (_, i) => at(-11 + i)));

    const result = await validateBatchSchedule({
      input: { publishedAts: [at(8, 15), at(9)] },
      user: OWNER,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['gap', 'cap']);
    expect(result.dailyLimit).toBe(20);
  });

  it('lets a moderator past the cap but not past the window or the gap', async () => {
    existingPosts(Array.from({ length: 20 }, (_, i) => at(-11 + i)));

    const pastCap = await validateBatchSchedule({
      input: { publishedAts: [at(9)] },
      user: MODERATOR,
    });
    expect(pastCap.ok).toBe(true);
    expect(pastCap.dailyLimit).toBe(20);
    expect(pastCap.perDay).toEqual([{ day: '2026-10-01', existing: 20, incoming: 1 }]);

    const tooClose = await validateBatchSchedule({
      input: { publishedAts: [at(9, 20), at(0, 2)] },
      user: MODERATOR,
    });
    expect(tooClose.ok).toBe(false);
    expect(tooClose.issues.map((issue) => issue.code)).toEqual(['lead', 'gap']);
  });
});

describe('scheduleBatch', () => {
  it('claims the idempotency key once and refuses a replay before validating or writing', async () => {
    redisMock.sysRedis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const input = batchOf([at(2)], { idempotencyKey: '0b1f7a2e-6d1c-4d8e-9a7b-2f3c4d5e6f70' });

    await scheduleBatch({ input, ctx: ctxFor() });
    await expect(scheduleBatch({ input, ctx: ctxFor() })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    expect(redisMock.sysRedis.set).toHaveBeenCalledTimes(2);
    expect(redisMock.sysRedis.set.mock.calls[0]).toEqual([
      'lock:post-batch:7:0b1f7a2e-6d1c-4d8e-9a7b-2f3c4d5e6f70',
      '1',
      { NX: true, EX: 3600 },
    ]);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('refuses the whole chunk with every issue, writing nothing', async () => {
    existingPosts([at(2)]);

    await expect(
      scheduleBatch({ input: batchOf([at(2, 10), at(0, 2)]), ctx: ctxFor() })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Post 2 must be at least 10 minutes.*Post 1 is too close/s),
    });
    nothingWritten();
  });

  it('refuses a version that is not published, before any write', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({ id: 30, status: 'Scheduled' });

    await expect(
      scheduleBatch({ input: batchOf([at(2)], { modelVersionId: 30 }), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Publish') });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('keeps the uploads when it rolls back: image rows go, storage objects stay', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValueOnce([{ id: 1000 }]);
    addImage.mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'nope' }));

    await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(dbMock.dbWrite.image.deleteMany).toHaveBeenCalledWith({ where: { postId: 100 } });
    expect(dbMock.dbWrite.post.delete).toHaveBeenCalledWith({ where: { id: 100 } });
    expect(removePost).not.toHaveBeenCalled();
  });

  it('masks a server-side failure message', async () => {
    updatePost.mockRejectedValueOnce(
      new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'connect ECONNREFUSED 10.0.0.1' })
    );

    const result = await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(result.failedAt).toBe(0);
    expect(result.message).not.toContain('ECONNREFUSED');
  });

  it('checks the model version before any write', async () => {
    canViewVersion.mockResolvedValue(false);

    await expect(
      scheduleBatch({ input: batchOf([at(2)], { modelVersionId: 30 }), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.modelVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 30 } })
    );
    expect(canViewVersion).toHaveBeenCalledWith(expect.objectContaining({ id: 30 }), OWNER);
    nothingWritten();
  });

  it('creates, fills, tags and schedules each post in order', async () => {
    const dates = [at(2), at(3)];
    const ctx = ctxFor();

    const result = await scheduleBatch({
      input: batchOf(dates, {
        modelVersionId: 30,
        tags: ['anime', 'portrait'],
        tools: [1, 2],
        techniques: [9],
      }),
      ctx,
    });

    expect(result).toEqual({
      created: [
        { postId: 100, publishedAt: dates[0].toISOString() },
        { postId: 101, publishedAt: dates[1].toISOString() },
      ],
    });
    expect(createPost).toHaveBeenCalledTimes(2);
    expect(createPost.mock.calls[0][0]).toEqual({
      input: { modelVersionId: 30, title: 'Post 1', tags: ['anime', 'portrait'] },
      ctx,
    });
    expect(addImage.mock.calls.map(([arg]) => [arg.postId, arg.index, arg.url])).toEqual([
      [100, 0, '0-a'],
      [100, 1, '0-b'],
      [101, 0, '1-a'],
      [101, 1, '1-b'],
    ]);
    expect(addImage.mock.calls[0][0]).toMatchObject({ user: OWNER, type: 'image' });
    expect(addTools).toHaveBeenCalledTimes(2);
    expect(addTools.mock.calls[0][0]).toEqual({
      data: [
        { imageId: 1000, toolId: 1 },
        { imageId: 1000, toolId: 2 },
        { imageId: 1001, toolId: 1 },
        { imageId: 1001, toolId: 2 },
      ],
      user: OWNER,
    });
    expect(addTools.mock.calls[1][0].data.map((row: { imageId: number }) => row.imageId)).toEqual([
      1002, 1002, 1003, 1003,
    ]);
    expect(addTechniques).toHaveBeenCalledTimes(2);
    expect(addTechniques.mock.calls[1][0]).toEqual({
      data: [
        { imageId: 1002, techniqueId: 9 },
        { imageId: 1003, techniqueId: 9 },
      ],
      user: OWNER,
    });
    expect(updatePost.mock.calls.map(([arg]) => arg)).toEqual([
      { input: { id: 100, publishedAt: dates[0] }, ctx },
      { input: { id: 101, publishedAt: dates[1] }, ctx },
    ]);
    expect(removePost).not.toHaveBeenCalled();
  });

  it('skips tools and techniques when the batch has none, and the version check without a version', async () => {
    await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(addTools).not.toHaveBeenCalled();
    expect(addTechniques).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
    expect(updatePost).toHaveBeenCalledTimes(1);
  });

  it('deletes the post that failed mid-chunk, keeps the ones before it and stops', async () => {
    addImage.mockImplementationOnce(async () => ({ id: 1000 }));
    addImage.mockImplementationOnce(async () => ({ id: 1001 }));
    addImage.mockImplementationOnce(async () => ({ id: 1002 }));
    addImage.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'That file is not an image' })
    );
    const dates = [at(2), at(3), at(4)];

    const result = await scheduleBatch({ input: batchOf(dates), ctx: ctxFor() });

    expect(result).toEqual({
      created: [{ postId: 100, publishedAt: dates[0].toISOString() }],
      failedAt: 1,
      message: 'That file is not an image',
    });
    expect(createPost).toHaveBeenCalledTimes(2);
    expect(removePost).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.deleteMany).toHaveBeenCalledWith({ where: { postId: 101 } });
    expect(dbMock.dbWrite.post.delete).toHaveBeenCalledWith({ where: { id: 101 } });
    expect(updatePost).toHaveBeenCalledTimes(1);
    expect(updatePost.mock.calls[0][0].input.id).toBe(100);
  });

  it('reports a generic message for an unknown error and deletes nothing when create itself failed', async () => {
    createPost.mockRejectedValueOnce(new Error('connection reset'));

    const result = await scheduleBatch({ input: batchOf([at(2), at(3)]), ctx: ctxFor() });

    expect(result).toEqual({
      created: [],
      failedAt: 0,
      message: expect.not.stringContaining('connection reset'),
    });
    expect(result.message).toBeTruthy();
    expect(removePost).not.toHaveBeenCalled();
    expect(addImage).not.toHaveBeenCalled();
  });

  it('still reports the failure when the compensating delete throws', async () => {
    updatePost.mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'nope' }));
    dbMock.dbWrite.post.delete.mockRejectedValueOnce(new Error('delete failed'));

    const result = await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(result).toEqual({ created: [], failedAt: 0, message: 'nope' });
    expect(dbMock.dbWrite.post.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });
});

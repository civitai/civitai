import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PostController from '~/server/controllers/post.controller';
import type * as PostService from '~/server/services/post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as VisibilityService from '~/server/services/model-version-visibility.service';
import type { ProtectedContext } from '~/server/createContext';
import type { ScheduleBatchInput } from '~/server/schema/post.schema';

const {
  createPost,
  updatePost,
  addImage,
  removePost,
  addTools,
  addTechniques,
  canViewVersion,
  heldLocks,
} = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePost: vi.fn(),
  addImage: vi.fn(),
  removePost: vi.fn(),
  addTools: vi.fn(),
  addTechniques: vi.fn(),
  canViewVersion: vi.fn(),
  heldLocks: new Set<string>(),
}));

// The real per-creator lock over an in-process one: a second holder is refused at once, where
// the real lock first retries for a few seconds.
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    if (heldLocks.has(options.key)) return null;
    heldLocks.add(options.key);
    try {
      return await operation();
    } finally {
      heldLocks.delete(options.key);
    }
  },
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
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
    id: 30,
    status: 'Published',
    model: { status: 'Published' },
  });
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
      input: { publishedAts: [at(8, 8), at(9)] },
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
      scheduleBatch({ input: batchOf([at(2, 8), at(0, 2)]), ctx: ctxFor() })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/Post 2 must be at least 10 minutes.*Post 1 is too close/s),
    });
    nothingWritten();
  });

  it('refuses a version whose model is not published, before any write', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      id: 30,
      status: 'Published',
      model: { status: 'UnpublishedViolation' },
    });

    await expect(
      scheduleBatch({ input: batchOf([at(2)], { modelVersionId: 30 }), ctx: ctxFor() })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('model is not published'),
    });
    nothingWritten();
  });

  it('refuses a version that is not published, before any write', async () => {
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      id: 30,
      status: 'Scheduled',
      model: { status: 'Published' },
    });

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

/**
 * A creator's posts as the service reads and writes them, so a second call sees what the first
 * one created. `post.findMany` answers only the filters the retry lookup sends and throws on any
 * other, so a changed query fails here instead of matching everything.
 */
type WorldPost = { id: number; createdAt: Date; publishedAt: Date | null; urls: string[] };
function worldOf(posts: WorldPost[] = []) {
  const store = new Map<string, string>();
  let nextId = 500;
  const byId = (id: number) => posts.find((post) => post.id === id) as WorldPost;

  createPost.mockImplementation(async () => {
    const post = { id: nextId++, createdAt: new Date(), publishedAt: null, urls: [] };
    posts.push(post);
    return { id: post.id };
  });
  addImage.mockImplementation(async (arg: { postId: number; url: string }) => {
    byId(arg.postId).urls.push(arg.url);
    return { id: 9000 + byId(arg.postId).urls.length };
  });
  updatePost.mockImplementation(async (arg: { input: { id: number; publishedAt: Date } }) => {
    byId(arg.input.id).publishedAt = arg.input.publishedAt;
  });
  dbMock.dbWrite.$queryRaw.mockImplementation((async () =>
    posts
      .filter((post) => post.publishedAt && post.publishedAt >= START_OF_TODAY_UTC)
      .map((post) => ({ publishedAt: post.publishedAt }))) as never);
  type Where = {
    id?: { in: number[] };
    userId: number;
    publishedAt?: { not: null } | { gt: Date };
    createdAt?: { gte: Date };
    images?: { some: { url: { in: string[] } } };
  };
  dbMock.dbWrite.post.findMany.mockImplementation((async ({ where }: { where: Where }) => {
    const known = ['id', 'userId', 'publishedAt', 'createdAt', 'images'];
    const unknown = Object.keys(where).filter((key) => !known.includes(key));
    if (unknown.length) throw new Error(`fake post.findMany: unhandled filter ${unknown}`);
    if (where.userId !== OWNER.id) return [];
    return posts
      .filter((post) => !where.id || where.id.in.includes(post.id))
      .filter((post) => {
        if (!where.publishedAt) return true;
        if ('not' in where.publishedAt) return post.publishedAt !== null;
        return !!post.publishedAt && post.publishedAt > where.publishedAt.gt;
      })
      .filter((post) => !where.createdAt || post.createdAt >= where.createdAt.gte)
      .filter(
        (post) => !where.images || post.urls.some((url) => where.images?.some.url.in.includes(url))
      )
      .map((post) => ({
        id: post.id,
        publishedAt: post.publishedAt,
        images: post.urls.map((url) => ({ url })),
      }));
  }) as never);
  redisMock.sysRedis.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.sysRedis.set.mockImplementation(async (key: string, value: string) => {
    store.set(key, value);
    return 'OK';
  });
  return posts;
}

const KEYS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const NEW_KEYS = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
const keyed = (input: ScheduleBatchInput, keys: string[]): ScheduleBatchInput => ({
  ...input,
  posts: input.posts.map((post, index) => ({ ...post, clientKey: keys[index] })),
});

describe('scheduleBatch: an attempt repeated after the client gave up on it', () => {
  it('a retry with the same client keys gets the original posts back and creates nothing', async () => {
    worldOf();
    const input = keyed(batchOf([at(24), at(48)]), KEYS);
    const first = await scheduleBatch({ input, ctx: ctxFor() });

    const retry = await scheduleBatch({ input, ctx: ctxFor() });

    // On main the retry is refused: "Post 1 is too close to a post you already have scheduled".
    expect(retry).toEqual({
      created: first.created.map((entry) => ({ ...entry, alreadyCreated: true })),
    });
    expect(createPost).toHaveBeenCalledTimes(2);
  });

  it('recognises a retry by its key even after the post went live, where its upload cannot', async () => {
    const world = worldOf();
    const input = keyed(batchOf([at(0, 20)]), KEYS);
    const first = await scheduleBatch({ input, ctx: ctxFor() });
    vi.setSystemTime(at(1));

    const retry = await scheduleBatch({ input, ctx: ctxFor() });

    expect(retry.created).toEqual([{ ...first.created[0], alreadyCreated: true }]);
    expect(world).toHaveLength(1);
  });

  it('recognises a resubmit with new keys by its first upload, and reports the ORIGINAL time', async () => {
    const world = worldOf();
    const dates = [at(24), at(48)];
    await scheduleBatch({ input: keyed(batchOf(dates), KEYS), ctx: ctxFor() });

    // The creator moved both dates by two hours before resubmitting from the composer.
    const resubmit = await scheduleBatch({
      input: keyed(batchOf([at(26), at(50)]), NEW_KEYS),
      ctx: ctxFor(),
    });

    expect(resubmit.created).toEqual([
      { postId: 500, publishedAt: dates[0].toISOString(), alreadyCreated: true },
      { postId: 501, publishedAt: dates[1].toISOString(), alreadyCreated: true },
    ]);
    expect(world).toHaveLength(2);
  });

  it('creates only the posts of a chunk the earlier attempt did not reach', async () => {
    const world = worldOf();
    const dates = [at(24), at(48), at(72)];
    await scheduleBatch({ input: keyed(batchOf(dates.slice(0, 1)), KEYS), ctx: ctxFor() });

    const retry = await scheduleBatch({ input: keyed(batchOf(dates), KEYS), ctx: ctxFor() });

    expect(retry.created.map((entry) => [entry.postId, !!entry.alreadyCreated])).toEqual([
      [500, true],
      [501, false],
      [502, false],
    ]);
    expect(world.map((post) => post.urls[0])).toEqual(['0-a', '1-a', '2-a']);
  });

  it('gives an image already on a PUBLISHED post a new post', async () => {
    const world = worldOf([{ id: 400, createdAt: at(-2), publishedAt: at(-1), urls: ['0-a'] }]);

    const result = await scheduleBatch({ input: keyed(batchOf([at(24)]), KEYS), ctx: ctxFor() });

    expect(result.created).toEqual([{ postId: 500, publishedAt: at(24).toISOString() }]);
    expect(world).toHaveLength(2);
  });

  it('gives an image on a still-scheduled post made outside the window a new post', async () => {
    const world = worldOf([{ id: 400, createdAt: at(-7), publishedAt: at(30), urls: ['0-a'] }]);

    const result = await scheduleBatch({ input: keyed(batchOf([at(24)]), KEYS), ctx: ctxFor() });

    expect(result.created).toEqual([{ postId: 500, publishedAt: at(24).toISOString() }]);
    expect(world).toHaveLength(2);
  });

  it('still refuses a new post 3 minutes from one already scheduled', async () => {
    worldOf([{ id: 400, createdAt: at(-1), publishedAt: at(24), urls: ['other'] }]);

    await expect(
      scheduleBatch({ input: keyed(batchOf([at(24, 8)]), KEYS), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('too close') });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('still refuses a different upload at the same instant as a scheduled post', async () => {
    worldOf([{ id: 400, createdAt: at(-1), publishedAt: at(24), urls: ['other'] }]);

    await expect(
      scheduleBatch({ input: keyed(batchOf([at(24)]), KEYS), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('too close') });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('refuses a retry that arrives while the original still runs, then serves it once done', async () => {
    worldOf();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const create = createPost.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    createPost.mockImplementationOnce(async (...args: unknown[]) => {
      await gate;
      return create(...args);
    });
    const input = keyed(batchOf([at(24)]), KEYS);

    const original = scheduleBatch({ input, ctx: ctxFor() });
    // The original holds the lock and is mid-way through creating its post.
    await vi.waitFor(() => expect(createPost).toHaveBeenCalledTimes(1));
    await expect(scheduleBatch({ input, ctx: ctxFor() })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('still running'),
    });
    expect(createPost).toHaveBeenCalledTimes(1);

    release();
    const done = await original;
    const later = await scheduleBatch({ input, ctx: ctxFor() });

    expect(later.created).toEqual([{ ...done.created[0], alreadyCreated: true }]);
    expect(createPost).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleBatch: the step breakdown a slow call logs', () => {
  const logAxiom = loggingMock.logToAxiom;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const stepLines = () =>
    logAxiom.mock.calls
      .map(([payload]) => payload as Record<string, unknown>)
      .filter((payload) => payload.name === 'post-schedule-batch-steps');

  beforeEach(() => {
    logAxiom.mockClear();
    vi.stubEnv('TRPC_SLOW_LOG_MS', '1');
    // Nothing from an earlier attempt: the world fakes above outlive their own tests.
    dbMock.dbWrite.post.findMany.mockReset().mockResolvedValue([]);
    redisMock.sysRedis.get.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('logs where a slow call spent its time, in durations and counts only', async () => {
    addImage.mockImplementation(async () => {
      await pause(5);
      return { id: 1 };
    });

    await scheduleBatch({
      input: batchOf([at(24), at(48)], { tools: [1], techniques: [9] }),
      ctx: ctxFor(),
    });

    const [line] = stepLines();
    expect(stepLines()).toHaveLength(1);
    expect(line).toMatchObject({
      type: 'info',
      userId: OWNER.id,
      posts: 2,
      created: 2,
      alreadyCreated: 0,
      images: 4,
      failed: false,
    });
    expect(line.addImageMs as number).toBeGreaterThanOrEqual(15);
    expect(line.addImageMaxMs as number).toBeGreaterThanOrEqual(4);
    expect(line.durationMs as number).toBeGreaterThanOrEqual(line.addImageMs as number);
    for (const key of ['lockWaitMs', 'lookupMs', 'validateMs', 'createPostMs', 'toolsMs'])
      expect(typeof line[key]).toBe('number');
    // Nothing the creator wrote or uploaded.
    expect(JSON.stringify(line)).not.toMatch(/0-a|1-b|Post 1|Post 2/);
  });

  it('marks a slow call that was refused as failed', async () => {
    existingPosts([at(24)]);
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => {
      await pause(3);
      return [{ publishedAt: at(24) }];
    }) as never);

    await expect(
      scheduleBatch({ input: batchOf([at(24, 8)]), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(stepLines()).toEqual([expect.objectContaining({ failed: true, created: 0 })]);
  });

  it('logs nothing for a call under the slow threshold', async () => {
    vi.stubEnv('TRPC_SLOW_LOG_MS', '60000');

    await scheduleBatch({ input: batchOf([at(24)]), ctx: ctxFor() });

    expect(stepLines()).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PostController from '~/server/controllers/post.controller';
import type * as PostService from '~/server/services/post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as VisibilityService from '~/server/services/model-version-visibility.service';
import type * as RemixProvenance from '~/server/services/orchestrator/remix-provenance';
import type * as CacheHelpers from '~/server/utils/cache-helpers';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type { ProtectedContext } from '~/server/createContext';
import { scheduleBatchSchema, type ScheduleBatchInput } from '~/server/schema/post.schema';

const {
  createPost,
  updatePost,
  removePost,
  addTools,
  addTechniques,
  canViewVersion,
  createImageRow,
  createResources,
  deleteImageRows,
  recomputeNsfw,
  bustPostCaches,
  resolveToolTechnique,
  resolveProvenance,
  attachResource,
  enqueueIngestion,
  prodFlag,
  heldLocks,
} = vi.hoisted(() => ({
  createPost: vi.fn(),
  updatePost: vi.fn(),
  removePost: vi.fn(),
  addTools: vi.fn(),
  addTechniques: vi.fn(),
  canViewVersion: vi.fn(),
  createImageRow: vi.fn(),
  createResources: vi.fn(),
  deleteImageRows: vi.fn(),
  recomputeNsfw: vi.fn(),
  bustPostCaches: vi.fn(),
  resolveToolTechnique: vi.fn(),
  resolveProvenance: vi.fn(),
  attachResource: vi.fn(),
  enqueueIngestion: vi.fn(),
  prodFlag: { isProd: null as boolean | null },
  heldLocks: new Set<string>(),
}));

// `isProd` alone, and only while a test sets it: the cleanup job refuses to delete outside prod.
vi.mock('~/env/other', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    get isProd() {
      return prodFlag.isProd ?? original.isProd;
    },
  };
});

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
  deletePost: removePost,
  updatePostNsfwLevel: recomputeNsfw,
  bustCachesForPosts: bustPostCaches,
  resolveMetaToolAndTechnique: resolveToolTechnique,
  addResourceToPostImage: attachResource,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  addImageTools: addTools,
  addImageTechniques: addTechniques,
  createImage: createImageRow,
  createImageResources: createResources,
  deleteImages: deleteImageRows,
  enqueueImageIngestion: enqueueIngestion,
}));
vi.mock('~/server/services/orchestrator/remix-provenance', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixProvenance>()),
  resolveVerifiedSourceImageIds: resolveProvenance,
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  bustCacheTag: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/model-version-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof VisibilityService>()),
  canViewModelVersion: canViewVersion,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  getBatchMediaStatus,
  persistBatchMedia,
  removeBatchMedia,
  scheduleBatch,
  validateBatchSchedule,
} from '~/server/services/post-batch.service';
import {
  batchDraftImagesCleanup,
  selectExpiredBatchDraftImageIds,
} from '~/server/jobs/batch-draft-images';

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

/** Post `index` of a batch holds draft rows `2 * index + 1` and `2 * index + 2`. */
const draftIds = (postIndex: number) => [2 * postIndex + 1, 2 * postIndex + 2];
const batchOf = (
  dates: Date[],
  overrides: Partial<ScheduleBatchInput> = {}
): ScheduleBatchInput => ({
  modelVersionId: null,
  tags: [],
  tools: [],
  techniques: [],
  resourceIds: [],
  posts: dates.map((publishedAt, index) => ({
    title: `Post ${index + 1}`,
    publishedAt,
    images: draftIds(index).map((imageId) => ({ imageId })),
  })),
  ...overrides,
});

const DRAFT_WHERE = { postId: null, metadata: { path: ['batchDraft'], equals: true } };
type RawCall = [string[], ...unknown[]];
const sqlOf = ([strings]: RawCall) => strings.join('?').replace(/\s+/g, ' ');
/** A `Prisma.raw` literal reaches the mock as a value; real Prisma inlines it. */
const literal = (value: unknown) =>
  value && typeof value === 'object' && 'sql' in value ? (value as { sql: string }).sql : value;
/** The adoption writes, as `[imageId, postId, index]`. */
const adoptions = () =>
  (dbMock.dbWrite.$executeRaw.mock.calls as RawCall[])
    .filter((call) => sqlOf(call).includes('SET "postId" = ?'))
    .map(([, postId, index, , imageId]) => [imageId, postId, index]);
/** The un-adopt writes, by post id. */
const unadoptions = () =>
  (dbMock.dbWrite.$executeRaw.mock.calls as RawCall[])
    .filter((call) => sqlOf(call).includes('SET "postId" = NULL'))
    .map(([, , postId]) => postId);

const existingPosts = (dates: Date[]) =>
  dbMock.dbWrite.$queryRaw.mockResolvedValue(dates.map((publishedAt) => ({ publishedAt })));

const nothingWritten = () => {
  expect(createPost).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
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
  createPost.mockImplementation(async () => ({ id: nextPostId++ }));
  dbMock.dbWrite.$executeRaw.mockReset().mockResolvedValue(1);
  dbMock.dbWrite.image.updateMany.mockReset().mockResolvedValue({ count: 1 });
  dbMock.dbWrite.image.findMany.mockReset().mockResolvedValue([]);
  dbMock.dbWrite.imageResourceNew.findMany.mockReset().mockResolvedValue([]);
  createResources.mockResolvedValue(null);
  recomputeNsfw.mockResolvedValue(undefined);
  bustPostCaches.mockResolvedValue(undefined);
  updatePost.mockResolvedValue(undefined);
  removePost.mockResolvedValue(undefined);
  addTools.mockResolvedValue(undefined);
  addTechniques.mockResolvedValue(undefined);
  attachResource.mockResolvedValue([]);
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

  it('refuses a post whose draft row is missing or already on a post, and leaves no post', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const result = await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(result).toEqual({
      created: [],
      failedAt: 0,
      message: expect.stringContaining('no longer available'),
    });
    expect(createResources).not.toHaveBeenCalled();
    expect(updatePost).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.post.delete).toHaveBeenCalledWith({ where: { id: 100 } });
  });

  it('hands the images back to the draft when it rolls back, deleting no row', async () => {
    updatePost.mockRejectedValueOnce(new TRPCError({ code: 'BAD_REQUEST', message: 'nope' }));

    await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    const calls = dbMock.dbWrite.$executeRaw.mock.calls as RawCall[];
    const unadopt = calls[calls.length - 1];
    expect(sqlOf(unadopt)).toMatch(
      /SET "postId" = NULL, "index" = NULL, metadata = metadata \|\| jsonb_build_object\(\?, true\) WHERE "postId" = \?/
    );
    expect(literal(unadopt[1])).toBe("'batchDraft'");
    expect(unadopt[2]).toBe(100);
    expect(dbMock.dbWrite.post.delete).toHaveBeenCalledWith({ where: { id: 100 } });
    expect(dbMock.dbWrite.image.deleteMany).not.toHaveBeenCalled();
    expect(deleteImageRows).not.toHaveBeenCalled();
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

  it('creates, adopts, tags and schedules each post in order', async () => {
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
    expect(adoptions()).toEqual([
      [1, 100, 0],
      [2, 100, 1],
      [3, 101, 0],
      [4, 101, 1],
    ]);
    const [first] = dbMock.dbWrite.$executeRaw.mock.calls as RawCall[];
    expect(sqlOf(first)).toMatch(
      /SET "postId" = \?, "index" = \?, metadata = metadata - \? WHERE id = \? AND "userId" = \? AND "postId" IS NULL AND \(metadata->>\?\) = 'true'/
    );
    expect(first.slice(1).map(literal)).toEqual([
      100,
      0,
      "'batchDraft'",
      1,
      OWNER.id,
      "'batchDraft'",
    ]);
    expect(createResources.mock.calls.map(([arg]) => arg.imageId)).toEqual([1, 2, 3, 4]);
    expect(recomputeNsfw.mock.calls.map(([arg]) => arg)).toEqual([100, 101]);
    expect(bustPostCaches.mock.calls.map(([arg]) => arg)).toEqual([100, 101]);
    expect(addTools).toHaveBeenCalledTimes(2);
    expect(addTools.mock.calls[0][0]).toEqual({
      data: [
        { imageId: 1, toolId: 1 },
        { imageId: 1, toolId: 2 },
        { imageId: 2, toolId: 1 },
        { imageId: 2, toolId: 2 },
      ],
      user: OWNER,
    });
    expect(addTools.mock.calls[1][0].data.map((row: { imageId: number }) => row.imageId)).toEqual([
      3, 3, 4, 4,
    ]);
    expect(addTechniques).toHaveBeenCalledTimes(2);
    expect(addTechniques.mock.calls[1][0]).toEqual({
      data: [
        { imageId: 3, techniqueId: 9 },
        { imageId: 4, techniqueId: 9 },
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
    expect(attachResource).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
    expect(updatePost).toHaveBeenCalledTimes(1);
  });

  it('deletes the post that failed mid-chunk, keeps the ones before it and stops', async () => {
    dbMock.dbWrite.$executeRaw
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const dates = [at(2), at(3), at(4)];

    const result = await scheduleBatch({ input: batchOf(dates), ctx: ctxFor() });

    expect(result).toEqual({
      created: [{ postId: 100, publishedAt: dates[0].toISOString() }],
      failedAt: 1,
      message: expect.stringContaining('no longer available'),
    });
    expect(createPost).toHaveBeenCalledTimes(2);
    expect(removePost).not.toHaveBeenCalled();
    expect(unadoptions()).toEqual([101]);
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
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
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
 * A creator's posts and draft rows as the service reads and writes them, so a second call sees
 * what the first one created. Draft ids 1..20 start postless; adoption moves one onto a post and
 * an un-adopt returns it. `post.findMany` answers only the filters the retry lookup sends and
 * throws on any other, so a changed query fails here instead of matching everything.
 */
type WorldPost = { id: number; createdAt: Date; publishedAt: Date | null; imageIds: number[] };
function worldOf(posts: WorldPost[] = []) {
  const store = new Map<string, string>();
  let nextId = 500;
  const byId = (id: number) => posts.find((post) => post.id === id) as WorldPost;
  const taken = new Set(posts.flatMap((post) => post.imageIds));
  const drafts = new Set(
    Array.from({ length: 20 }, (_, i) => i + 1).filter((id) => !taken.has(id))
  );

  createPost.mockImplementation(async () => {
    const post = { id: nextId++, createdAt: new Date(), publishedAt: null, imageIds: [] };
    posts.push(post);
    return { id: post.id };
  });
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: string[],
    ...values: unknown[]
  ) => {
    const sql = strings.join('?');
    if (sql.includes('SET "postId" = NULL')) {
      const post = byId(values[1] as number);
      const count = post.imageIds.length;
      for (const id of post.imageIds) drafts.add(id);
      post.imageIds = [];
      return count;
    }
    if (!sql.includes('SET "postId" = ?')) throw new Error(`fake $executeRaw: unhandled ${sql}`);
    const [postId, , , imageId] = values as [number, number, unknown, number];
    if (!drafts.delete(imageId)) return 0;
    byId(postId).imageIds.push(imageId);
    return 1;
  }) as never);
  dbMock.dbWrite.post.delete.mockImplementation((async ({ where }: { where: { id: number } }) => {
    posts.splice(posts.indexOf(byId(where.id)), 1);
    return { id: where.id };
  }) as never);
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
    images?: { some: { id: { in: number[] } } };
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
        (post) => !where.images || post.imageIds.some((id) => where.images?.some.id.in.includes(id))
      )
      .map((post) => ({
        id: post.id,
        publishedAt: post.publishedAt,
        images: post.imageIds.map((id) => ({ id })),
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
    expect(world.map((post) => post.imageIds)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it('recognises a resubmit with new keys by its first image after the post went live', async () => {
    const world = worldOf([{ id: 400, createdAt: at(-2), publishedAt: at(-1), imageIds: [1, 2] }]);

    const result = await scheduleBatch({ input: keyed(batchOf([at(24)]), KEYS), ctx: ctxFor() });

    expect(result.created).toEqual([
      { postId: 400, publishedAt: at(-1).toISOString(), alreadyCreated: true },
    ]);
    expect(world).toHaveLength(1);
  });

  it('refuses an image on a post made outside the window: a row is adopted once', async () => {
    const world = worldOf([{ id: 400, createdAt: at(-7), publishedAt: at(30), imageIds: [1, 2] }]);

    const result = await scheduleBatch({ input: keyed(batchOf([at(24)]), KEYS), ctx: ctxFor() });

    expect(result).toEqual({
      created: [],
      failedAt: 0,
      message: expect.stringContaining('no longer available'),
    });
    expect(world).toHaveLength(1);
    expect(world[0].imageIds).toEqual([1, 2]);
  });

  it('still refuses a new post 10 minutes from one already scheduled', async () => {
    worldOf([{ id: 400, createdAt: at(-1), publishedAt: at(24), imageIds: [19] }]);

    await expect(
      scheduleBatch({ input: keyed(batchOf([at(24, 15)]), KEYS), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('too close') });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('still refuses a different upload at the same instant as a scheduled post', async () => {
    worldOf([{ id: 400, createdAt: at(-1), publishedAt: at(24), imageIds: [19] }]);

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
    dbMock.dbWrite.$executeRaw.mockImplementation((async () => {
      await pause(5);
      return 1;
    }) as never);

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
    expect(line.adoptMs as number).toBeGreaterThanOrEqual(15);
    expect(line.durationMs as number).toBeGreaterThanOrEqual(line.adoptMs as number);
    for (const key of ['lockWaitMs', 'lookupMs', 'validateMs', 'createPostMs', 'toolsMs'])
      expect(typeof line[key]).toBe('number');
    // Nothing the creator wrote.
    expect(JSON.stringify(line)).not.toMatch(/Post 1|Post 2/);
  });

  it('marks a slow call that was refused as failed', async () => {
    existingPosts([at(24)]);
    dbMock.dbWrite.$queryRaw.mockImplementation((async () => {
      await pause(3);
      return [{ publishedAt: at(24) }];
    }) as never);

    await expect(
      scheduleBatch({ input: batchOf([at(24, 10)]), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(stepLines()).toEqual([expect.objectContaining({ failed: true, created: 0 })]);
  });

  it('logs nothing for a call under the slow threshold', async () => {
    vi.stubEnv('TRPC_SLOW_LOG_MS', '60000');

    await scheduleBatch({ input: batchOf([at(24)]), ctx: ctxFor() });

    expect(stepLines()).toEqual([]);
  });
});

describe('persistBatchMedia', () => {
  const upload = (url: string) => ({
    url,
    type: 'image' as const,
    meta: { prompt: 'a cat', engine: 'civitai' },
    metadata: { size: 10 },
    width: 1,
    height: 1,
  });

  beforeEach(() => {
    let nextImageId = 1000;
    createImageRow.mockImplementation(async () => ({ id: nextImageId++ }));
    resolveToolTechnique.mockResolvedValue({ toolId: 3, techniqueId: undefined });
    resolveProvenance.mockResolvedValue(null);
  });

  it('creates one postless, marked row per upload, with its resources, and maps each key to its id', async () => {
    const result = await persistBatchMedia({
      input: { images: [upload('a'), upload('b')] },
      user: OWNER,
    });

    expect(result).toEqual({
      images: [
        { url: 'a', imageId: 1000 },
        { url: 'b', imageId: 1001 },
      ],
    });
    expect(createImageRow).toHaveBeenCalledTimes(2);
    expect(createResources.mock.calls.map(([arg]) => arg.imageId)).toEqual([1000, 1001]);
    const [arg] = createImageRow.mock.calls[0];
    expect(arg).toMatchObject({
      url: 'a',
      userId: OWNER.id,
      metadata: { size: 10, batchDraft: true },
      toolIds: [3],
      verifiedSourceImageIds: null,
    });
    expect(arg.postId).toBeUndefined();
    expect(arg.skipIngestion).toBeUndefined();
  });

  it('stores the provenance the resolver verified, never the client claim', async () => {
    resolveProvenance.mockResolvedValue([77]);

    await persistBatchMedia({
      input: {
        images: [
          { ...upload('a'), generationWorkflowId: 'wf-1', meta: { extra: { provenance: 'x' } } },
        ],
      },
      user: OWNER,
    });

    expect(resolveProvenance).toHaveBeenCalledWith({
      userId: OWNER.id,
      provenance: 'x',
      workflowId: 'wf-1',
    });
    expect(createImageRow.mock.calls[0][0]).toMatchObject({ verifiedSourceImageIds: [77] });
    expect(createImageRow.mock.calls[0][0].generationWorkflowId).toBeUndefined();
  });
});

describe('getBatchMediaStatus', () => {
  it('reads only the caller’s postless drafts on the primary and keys them by id', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValueOnce([
      {
        id: 2,
        ingestion: 'Scanned',
        nsfwLevel: 4,
        blockedFor: null,
        needsReview: null,
        minor: false,
        poi: false,
      },
    ]);

    const result = await getBatchMediaStatus({ input: { ids: [1, 2] }, user: OWNER });

    expect(result).toEqual({
      images: {
        2: {
          ingestion: 'Scanned',
          nsfwLevel: 4,
          blockedFor: null,
          needsReview: null,
          minor: false,
          poi: false,
        },
      },
    });
    expect(dbMock.dbWrite.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2] }, userId: OWNER.id, ...DRAFT_WHERE } })
    );
    expect(dbMock.dbRead.image.findMany).not.toHaveBeenCalled();
  });
});

describe('removeBatchMedia', () => {
  it('deletes through the image deletion path, scoped to the caller’s postless drafts', async () => {
    deleteImageRows.mockResolvedValueOnce([{ id: 1 }, { id: 3 }]);

    const result = await removeBatchMedia({ input: { ids: [1, 2, 3] }, user: OWNER });

    expect(result).toEqual({ removed: [1, 3] });
    expect(deleteImageRows).toHaveBeenCalledTimes(1);
    const [ids, updatePosts, options] = deleteImageRows.mock.calls[0];
    expect(ids).toEqual([1, 2, 3]);
    expect(updatePosts).toBe(false);
    const where = options.onlyWhere.sql.replace(/\s+/g, ' ');
    expect(where).toMatch(
      /^"Image"."userId" = \? AND "Image"."postId" IS NULL AND \("Image".metadata->>'batchDraft'\) = 'true'/
    );
    expect(where).toMatch(/"needsReview" IS DISTINCT FROM 'appeal'/);
    expect(where).toMatch(/"needsReview" IS DISTINCT FROM 'csam'/);
    expect(where).toMatch(/AND NOT \( "Image"."userId" = -?\d+ OR/);
    expect(options.onlyWhere.values[0]).toBe(OWNER.id);
    expect(dbMock.dbWrite.image.deleteMany).not.toHaveBeenCalled();
  });
});

describe('batch-draft-images-cleanup', () => {
  beforeEach(() => {
    prodFlag.isProd = true;
    setEnv({ DATABASE_IS_PROD: true });
    dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    prodFlag.isProd = null;
  });

  it('selects postless marked rows past retention and under no hold, oldest first, from the replica', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: 5 }, { id: 6 }]);
    const cutoff = at(-24 * 7);

    const ids = await selectExpiredBatchDraftImageIds(cutoff, 500);

    expect(ids).toEqual([5, 6]);
    const [call] = dbMock.dbRead.$queryRaw.mock.calls as RawCall[];
    expect(sqlOf(call)).toMatch(
      /SELECT "Image".id FROM "Image" WHERE \? AND "Image"."createdAt" < \? ORDER BY "Image"."createdAt" LIMIT \?/
    );
    const holds = call[1] as { sql: string };
    // The first two conjuncts are the partial index's predicate, spelled the same.
    expect(holds.sql.replace(/\s+/g, ' ')).toMatch(
      /^ "Image"."postId" IS NULL AND \("Image".metadata->>'batchDraft'\) = 'true' AND "Image"."needsReview" IS DISTINCT FROM 'appeal' AND "Image"."needsReview" IS DISTINCT FROM 'csam' AND NOT \( "Image"."userId" = -?\d+ OR/
    );
    expect(call.slice(-2)).toEqual([cutoff, 500]);
  });

  it('deletes what it selected under the same holds on the primary, until the selection is empty', async () => {
    dbMock.dbRead.$queryRaw
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => ({ id: i + 1 })))
      .mockResolvedValueOnce([{ id: 501 }])
      .mockResolvedValueOnce([]);
    deleteImageRows.mockImplementation(async (ids: number[]) => ids.map((id) => ({ id })));

    const result = await batchDraftImagesCleanup.run({}).result;

    expect(result).toEqual({ deleted: 501 });
    expect(deleteImageRows).toHaveBeenCalledTimes(2);
    expect(deleteImageRows.mock.calls[1][0]).toEqual([501]);
    const where = deleteImageRows.mock.calls[0][2].onlyWhere.sql.replace(/\s+/g, ' ');
    expect(where).toMatch(
      /^ "Image"."postId" IS NULL AND \("Image".metadata->>'batchDraft'\) = 'true' AND "Image"."needsReview" IS DISTINCT FROM 'appeal' AND "Image"."needsReview" IS DISTINCT FROM 'csam' AND NOT \(/
    );
    const cutoffs = (dbMock.dbRead.$queryRaw.mock.calls as RawCall[]).map((call) => call.at(-2));
    expect(cutoffs).toEqual([at(-24 * 7, 0), at(-24 * 7, 0)]);
  });

  it('deletes nothing outside prod, and reports what it would have', async () => {
    prodFlag.isProd = false;
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: 5 }, { id: 6 }]);

    const result = await batchDraftImagesCleanup.run({}).result;

    expect(result).toEqual({ wouldDelete: 2 });
    expect(deleteImageRows).not.toHaveBeenCalled();
  });

  it('deletes nothing when the database is not the production one', async () => {
    setEnv({ DATABASE_IS_PROD: false });
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([{ id: 5 }]);

    const result = await batchDraftImagesCleanup.run({}).result;

    expect(result).toEqual({ wouldDelete: 0 });
    expect(deleteImageRows).not.toHaveBeenCalled();
  });
});

describe('scheduleBatch: a scanned image whose resources adoption changed', () => {
  const row = (id: number, ingestion: string) => ({
    id,
    url: `u${id}`,
    type: 'image',
    width: 10,
    height: 10,
    meta: { prompt: `p${id}` },
    ingestion,
  });

  it('is scanned again, once, after the resources are attached', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([row(1, 'Scanned'), row(2, 'Pending')]);
    dbMock.dbWrite.imageResourceNew.findMany
      .mockResolvedValueOnce([{ imageId: 1, modelVersionId: 8 }])
      .mockResolvedValueOnce([
        { imageId: 1, modelVersionId: 8 },
        { imageId: 1, modelVersionId: 30 },
        { imageId: 2, modelVersionId: 30 },
      ]);

    await scheduleBatch({ input: batchOf([at(2)], { modelVersionId: 30 }), ctx: ctxFor() });

    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1] } },
      data: { ingestion: 'Rescan' },
    });
    expect(enqueueIngestion).toHaveBeenCalledTimes(1);
    expect(enqueueIngestion.mock.calls[0][0]).toEqual({
      images: [{ id: 1, url: 'u1', type: 'image', width: 10, height: 10, prompt: 'p1' }],
      name: 'post-batch-rescan',
      userId: OWNER.id,
    });
    // After the listed resources, so the rescan sees them.
    expect(createResources.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueIngestion.mock.invocationCallOrder[0]
    );
  });

  it('is left alone when adoption attached nothing it did not have', async () => {
    dbMock.dbWrite.image.findMany.mockResolvedValue([row(1, 'Scanned'), row(2, 'Scanned')]);
    dbMock.dbWrite.imageResourceNew.findMany.mockResolvedValue([{ imageId: 1, modelVersionId: 8 }]);

    await scheduleBatch({ input: batchOf([at(2)]), ctx: ctxFor() });

    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });
});

describe('scheduleBatch: the extra resources listed on every image', () => {
  type Row = { id: number; type: 'image' | 'video'; meta: unknown };
  const postImages = (rows: Row[]) =>
    dbMock.dbWrite.image.findMany.mockImplementation((async ({
      where,
    }: {
      where: { id: { in: number[] } };
    }) => rows.filter((row) => where.id.in.includes(row.id))) as never);
  const plain = (id: number): Row => ({ id, type: 'image', meta: { prompt: 'x' } });

  it('lists each version once per chunk over every image of its posts, skipping the promoted version and repeats', async () => {
    postImages([plain(1), plain(2), plain(3), plain(4)]);

    const result = await scheduleBatch({
      input: batchOf([at(2), at(3)], { modelVersionId: 30, resourceIds: [30, 5, 6, 5] }),
      ctx: ctxFor(),
    });

    expect(result.failedAt).toBeUndefined();
    expect(attachResource.mock.calls.map(([arg]) => arg)).toEqual([
      { id: [1, 2, 3, 4], modelVersionId: 5, user: OWNER },
      { id: [1, 2, 3, 4], modelVersionId: 6, user: OWNER },
    ]);
    // After both posts are scheduled.
    expect(updatePost.mock.invocationCallOrder[1]).toBeLessThan(
      attachResource.mock.invocationCallOrder[0]
    );
  });

  it('checks every listed version is viewable before any write', async () => {
    canViewVersion.mockResolvedValue(false);

    await expect(
      scheduleBatch({ input: batchOf([at(2)], { resourceIds: [5] }), ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    nothingWritten();
  });

  it('leaves an on-site generation out instead of refusing the post', async () => {
    postImages([
      plain(1),
      { id: 2, type: 'image', meta: { civitaiResources: [{ modelVersionId: 9 }] } },
    ]);

    await scheduleBatch({ input: batchOf([at(2)], { resourceIds: [5] }), ctx: ctxFor() });

    expect(attachResource).toHaveBeenCalledTimes(1);
    expect(attachResource.mock.calls[0][0]).toEqual({ id: [1], modelVersionId: 5, user: OWNER });
  });

  it('discards every post the call created when the resource path refuses, with its message', async () => {
    postImages([plain(1), plain(2), plain(3), plain(4)]);
    attachResource.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Too many resources on this image.' })
    );

    const result = await scheduleBatch({
      input: batchOf([at(2), at(3)], { resourceIds: [5] }),
      ctx: ctxFor(),
    });

    expect(result).toEqual({
      created: [],
      failedAt: 0,
      message: 'Too many resources on this image.',
    });
    expect(unadoptions()).toEqual([100, 101]);
    expect(dbMock.dbWrite.post.delete.mock.calls.map(([arg]) => arg.where.id)).toEqual([100, 101]);
    expect(enqueueIngestion).not.toHaveBeenCalled();
  });

  it('accepts at most the per-image manual cap and defaults to none', () => {
    const base = {
      posts: [{ publishedAt: at(2).toISOString(), images: [{ imageId: 1 }] }],
    };
    const ten = Array.from({ length: 10 }, (_, i) => i + 1);

    expect(scheduleBatchSchema.safeParse({ ...base, resourceIds: ten }).success).toBe(true);
    expect(scheduleBatchSchema.safeParse({ ...base, resourceIds: [...ten, 11] }).success).toBe(
      false
    );
    expect(scheduleBatchSchema.parse(base).resourceIds).toEqual([]);
  });
});

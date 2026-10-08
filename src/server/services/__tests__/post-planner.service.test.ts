import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from '@prisma/client/runtime/library';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PostService from '~/server/services/post.service';
import type * as ImageService from '~/server/services/image.service';
import type * as Caches from '~/server/redis/caches';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelVersionController from '~/server/controllers/model-version.controller';
import type { ProtectedContext } from '~/server/createContext';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ModelStatus } from '~/shared/utils/prisma/enums';

const {
  updatePost,
  getPostEditDetail,
  getPostResources,
  publishModel,
  publishVersion,
  queueReindex,
  refreshPostCount,
  fetchStats,
} = vi.hoisted(() => ({
  updatePost: vi.fn(),
  getPostEditDetail: vi.fn(),
  getPostResources: vi.fn(async () => []),
  publishModel: vi.fn(),
  publishVersion: vi.fn(),
  queueReindex: vi.fn(),
  refreshPostCount: vi.fn(),
  fetchStats: vi.fn(async () => ({})),
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  updatePost,
  getPostEditDetail,
  getPostResources,
}));
vi.mock('~/server/controllers/model.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelController>()),
  publishModelHandler: publishModel,
}));
vi.mock('~/server/controllers/model-version.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelVersionController>()),
  publishModelVersionHandler: publishVersion,
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: queueReindex,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  userPostCountCache: { refresh: refreshPostCount },
  postStatCache: { fetch: fetchStats },
}));

import {
  getPlannerPostDetail,
  getScheduledPosts,
  reschedulePlannerPost,
  SCHEDULE_CHANGED_MESSAGE,
  shiftPlannerPosts,
  unschedulePlannerPosts,
} from '~/server/services/post-planner.service';

const DAY = 86_400_000;
const OWNER = { id: 7, onboarding: 0xff, muted: false } as ProtectedContext['user'];
// Release moves run the real `model.publish` / `modelVersion.publish` procedures, so the context
// carries what their middleware reads: the origin flag, the scope, the user.
const ctxFor = (user = OWNER, tokenScope = TokenScope.Full) =>
  ({
    user,
    tokenScope,
    acceptableOrigin: true,
    features: {},
    track: {},
    req: { headers: {} },
    res: {},
  } as unknown as ProtectedContext);

const scheduledAt = new Date(Date.now() + 2 * DAY);
const target = new Date(Date.now() + 5 * DAY);

const standalonePost = {
  id: 11,
  userId: 7,
  publishedAt: scheduledAt,
  modelVersionId: null,
  modelVersion: null,
};
const releasePost = (modelStatus: ModelStatus, modelOwner = 7) => ({
  ...standalonePost,
  modelVersionId: 30,
  modelVersion: {
    id: 30,
    status: ModelStatus.Scheduled,
    modelId: 40,
    model: { userId: modelOwner, status: modelStatus },
  },
});

const findUnique = dbMock.dbWrite.post.findUnique;
const findMany = dbMock.dbWrite.post.findMany;
const countVersions = dbMock.dbWrite.modelVersion.count;

// The release controllers fan the new date out to the post; the service re-reads it.
const releaseMovesPostTo = (publishedAt: Date | 'now') =>
  findUnique.mockResolvedValueOnce({
    publishedAt: publishedAt === 'now' ? new Date() : publishedAt,
  });

const nothingMoved = () => {
  expect(updatePost).not.toHaveBeenCalled();
  expect(publishModel).not.toHaveBeenCalled();
  expect(publishVersion).not.toHaveBeenCalled();
  expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockReset();
  findUnique.mockResolvedValue(standalonePost);
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  countVersions.mockReset();
  countVersions.mockResolvedValue(0);
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
  updatePost.mockImplementation(async ({ id, publishedAt }) => ({ id, publishedAt, userId: 7 }));
});

describe('reschedulePlannerPost — standalone posts', () => {
  it('moves the owner’s scheduled post through updatePost', async () => {
    const result = await reschedulePlannerPost({
      id: 11,
      target,
      expectedScope: 'post',
      ctx: ctxFor(),
    });

    expect(result).toEqual({ publishedAt: target.toISOString(), scope: 'post', movedPostIds: [] });
    expect(updatePost).toHaveBeenCalledTimes(1);
    expect(updatePost).toHaveBeenCalledWith({ id: 11, publishedAt: target, user: OWNER });
    expect(publishModel).not.toHaveBeenCalled();
    expect(publishVersion).not.toHaveBeenCalled();
  });

  it('publishes it now', async () => {
    const before = Date.now();
    await reschedulePlannerPost({ id: 11, target: 'now', expectedScope: 'post', ctx: ctxFor() });

    const { publishedAt } = updatePost.mock.calls[0][0] as { publishedAt: Date };
    expect(publishedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(publishedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('refuses another user’s post as not found, without writing', async () => {
    findUnique.mockResolvedValue({ ...standalonePost, userId: 8 });

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'post', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    nothingMoved();
  });

  it.each([
    ['too soon', new Date(Date.now() + 5 * 60_000)],
    ['past the 3-month cap', new Date(Date.now() + 100 * DAY)],
  ])('refuses a date %s instead of publishing now', async (_label, date) => {
    for (const post of [standalonePost, releasePost(ModelStatus.Published)]) {
      findUnique.mockResolvedValueOnce(post);
      await expect(
        reschedulePlannerPost({
          id: 11,
          target: date,
          expectedScope: post.modelVersion ? 'version' : 'post',
          ctx: ctxFor(),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    nothingMoved();
  });

  it('refuses a post that is already live', async () => {
    findUnique.mockResolvedValue({ ...standalonePost, publishedAt: new Date(Date.now() - 60_000) });

    await expect(
      reschedulePlannerPost({ id: 11, target: 'now', expectedScope: 'post', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    nothingMoved();
  });

  it('answers CONFLICT when the post went live before the write landed', async () => {
    updatePost.mockImplementation(async ({ id }) => ({ id, publishedAt: scheduledAt }));

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'post', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('reschedulePlannerPost — the expectedScope check', () => {
  it('refuses a chip drop the UI thought was standalone when the server sees a release', async () => {
    findUnique.mockResolvedValue(releasePost(ModelStatus.Scheduled));

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'post', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: SCHEDULE_CHANGED_MESSAGE });
    nothingMoved();
  });

  it('refuses a release move the UI confirmed when the version has since gone live', async () => {
    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'version', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: SCHEDULE_CHANGED_MESSAGE });
    nothingMoved();
  });

  it('refuses version-vs-model drift the same way', async () => {
    findUnique.mockResolvedValue(releasePost(ModelStatus.Published));

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'model', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    nothingMoved();
  });
});

describe('reschedulePlannerPost — posts on a scheduled release', () => {
  // The procedures' ownership guards read through the lag router, which may pick either client.
  beforeEach(() => {
    for (const db of [dbMock.dbRead, dbMock.dbWrite]) {
      db.model.findUnique.mockResolvedValue({ userId: 7 });
      db.model.findFirst.mockResolvedValue({ userId: 7 });
      db.modelVersion.findUnique.mockResolvedValue({ id: 30, modelId: 40, model: { userId: 7 } });
    }
  });

  it('reschedules the whole model when the model has not gone live, with the procedure ctx', async () => {
    findUnique.mockResolvedValueOnce(releasePost(ModelStatus.Scheduled));
    releaseMovesPostTo(target);
    findMany.mockResolvedValueOnce([{ id: 12 }, { id: 13 }]);
    const ctx = ctxFor();

    const result = await reschedulePlannerPost({ id: 11, target, expectedScope: 'model', ctx });

    expect(result).toEqual({
      publishedAt: target.toISOString(),
      scope: 'model',
      movedPostIds: [12, 13],
    });
    expect(publishModel).toHaveBeenCalledTimes(1);
    expect(publishModel.mock.calls[0][0]).toMatchObject({
      input: { id: 40, versionIds: [30], publishedAt: target },
      ctx: { user: ctx.user },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 7, modelVersionId: 30, id: { not: 11 }, publishedAt: target },
      })
    );
    expect(updatePost).not.toHaveBeenCalled();
    expect(publishVersion).not.toHaveBeenCalled();
  });

  it('reschedules only the version when the model is already published', async () => {
    findUnique.mockResolvedValueOnce(releasePost(ModelStatus.Published));
    releaseMovesPostTo(target);
    const ctx = ctxFor();

    const result = await reschedulePlannerPost({ id: 11, target, expectedScope: 'version', ctx });

    expect(result.scope).toBe('version');
    expect(publishVersion).toHaveBeenCalledTimes(1);
    expect(publishVersion.mock.calls[0][0]).toMatchObject({
      input: { id: 30, publishedAt: target },
      ctx: { user: ctx.user },
    });
    expect(publishModel).not.toHaveBeenCalled();
  });

  it('publishes the release now with no date, so the controller treats it as immediate', async () => {
    findUnique.mockResolvedValueOnce(releasePost(ModelStatus.Published));
    releaseMovesPostTo('now');

    await reschedulePlannerPost({ id: 11, target: 'now', expectedScope: 'version', ctx: ctxFor() });

    expect(publishVersion.mock.calls[0][0]).toMatchObject({
      input: { id: 30, publishedAt: undefined },
    });
    expect(updatePost).not.toHaveBeenCalled();
  });

  it('treats a post on someone else’s release as standalone', async () => {
    findUnique.mockResolvedValue(releasePost(ModelStatus.Scheduled, 99));

    const result = await reschedulePlannerPost({
      id: 11,
      target,
      expectedScope: 'post',
      ctx: ctxFor(),
    });

    expect(result.scope).toBe('post');
    expect(updatePost).toHaveBeenCalledTimes(1);
    expect(publishModel).not.toHaveBeenCalled();
  });

  it.each([
    ['an API key without ModelsWrite', ctxFor(OWNER, TokenScope.MediaWrite)],
    ['a muted account', ctxFor({ ...OWNER, muted: true })],
    [
      'an account that must verify its email',
      ctxFor({ ...OWNER, meta: { emailVerificationRequired: true } }),
    ],
  ])('refuses %s without moving the release', async (_label, ctx) => {
    findUnique.mockResolvedValue(releasePost(ModelStatus.Scheduled));

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'model', ctx })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    nothingMoved();
  });

  it('refuses to move a model release that another scheduled version shares', async () => {
    findUnique.mockResolvedValue(releasePost(ModelStatus.Scheduled));
    countVersions.mockResolvedValue(1);

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'model', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(countVersions).toHaveBeenCalledWith({
      where: { modelId: 40, status: ModelStatus.Scheduled, id: { not: 30 } },
    });
    nothingMoved();
  });

  it('answers CONFLICT when the release moved but the post did not follow', async () => {
    findUnique.mockResolvedValueOnce(releasePost(ModelStatus.Published));
    releaseMovesPostTo(scheduledAt);

    await expect(
      reschedulePlannerPost({ id: 11, target, expectedScope: 'version', ctx: ctxFor() })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(publishVersion).toHaveBeenCalledTimes(1);
  });
});

describe('unschedulePlannerPosts', () => {
  it('clears standalone posts in one statement, skips release posts, and reindexes', async () => {
    findMany
      .mockResolvedValueOnce([standalonePost, { ...releasePost(ModelStatus.Scheduled), id: 12 }])
      .mockResolvedValueOnce([]);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 11 }]);
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: 101 }, { id: 102 }]);

    const result = await unschedulePlannerPosts({ ids: [11, 12, 99], user: OWNER });

    expect(result).toEqual({ unscheduledIds: [11], skippedReleaseIds: [12] });
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toMatch(
      /UPDATE "Post"[\s\S]*"publishedAt" = NULL[\s\S]*RETURNING id/
    );
    const joined = values.find(
      (value): value is Sql => typeof value === 'object' && value !== null && 'values' in value
    );
    expect(joined?.values).toEqual([11]);
    expect(values).toContain(7);
    expect(queueReindex).toHaveBeenCalledWith({ ids: [101, 102], action: 'Update' });
    expect(refreshPostCount).toHaveBeenCalledWith(7);
  });

  it('writes nothing when every post is release-bound', async () => {
    findMany.mockResolvedValueOnce([releasePost(ModelStatus.Scheduled)]);

    const result = await unschedulePlannerPosts({ ids: [11], user: OWNER });

    expect(result).toEqual({ unscheduledIds: [], skippedReleaseIds: [11] });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(queueReindex).not.toHaveBeenCalled();
  });

  it('only loads the caller’s own still-scheduled posts', async () => {
    await unschedulePlannerPosts({ ids: [11], user: OWNER });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [11] }, userId: 7, publishedAt: { gt: expect.any(Date) } },
      })
    );
  });
});

describe('shiftPlannerPosts', () => {
  // Fixed to a UTC day two days out so the cap arithmetic has a known day to fill.
  const day = new Date(Date.now() + 2 * DAY);
  const at = (hour: number, minute: number) =>
    new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute));
  const own = (id: number, publishedAt: Date) => ({ ...standalonePost, id, publishedAt });

  it('moves every standalone post by the delta, in order, and reports the release posts it skipped', async () => {
    findMany
      .mockResolvedValueOnce([
        own(11, at(10, 7)),
        own(13, at(12, 7)),
        { ...releasePost(ModelStatus.Scheduled), id: 12 },
      ])
      .mockResolvedValueOnce([]);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 11, publishedAt: at(11, 7) },
      { id: 13, publishedAt: at(13, 7) },
    ]);
    dbMock.dbWrite.image.findMany.mockResolvedValue([{ id: 101 }]);

    const result = await shiftPlannerPosts({ ids: [11, 12, 13], deltaMinutes: 60, user: OWNER });

    expect(result).toEqual({
      moved: [
        { id: 11, publishedAt: at(11, 7).toISOString() },
        { id: 13, publishedAt: at(13, 7).toISOString() },
      ],
      skippedReleaseIds: [12],
    });
    expect(updatePost).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toMatch(
      /UPDATE "Post" p[\s\S]*FROM \(VALUES[\s\S]*"userId" = \?[\s\S]*"publishedAt" > NOW\(\)[\s\S]*RETURNING p\.id/
    );
    expect(values).toContain(7);
    const flat = (value: unknown): unknown[] =>
      typeof value === 'object' && value !== null && 'values' in value
        ? (value as Sql).values.flatMap(flat)
        : [value];
    expect(values.flatMap(flat)).toEqual(expect.arrayContaining([11, at(11, 7), 13, at(13, 7)]));
    expect(dbMock.dbWrite.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: { in: [11, 13] } } })
    );
    expect(queueReindex).toHaveBeenCalledWith({ ids: [101], action: 'Update' });
    expect(refreshPostCount).toHaveBeenCalledWith(7);
  });

  it('refuses a shift that lands inside the gap of another scheduled post, writing nothing', async () => {
    findMany
      .mockResolvedValueOnce([own(11, at(10, 7))])
      .mockResolvedValueOnce([{ publishedAt: at(11, 17) }]);

    await expect(
      shiftPlannerPosts({ ids: [11], deltaMinutes: 60, user: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('too close') });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a shift that breaches the daily cap, writing nothing', async () => {
    // 20 is the base daily limit; the day is full before the shifted post arrives.
    const full = Array.from({ length: 20 }, (_, hour) => ({ publishedAt: at(hour, 7) }));
    findMany.mockResolvedValueOnce([own(11, at(11, 37))]).mockResolvedValueOnce(full);

    await expect(
      shiftPlannerPosts({ ids: [11], deltaMinutes: 60, user: OWNER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('daily limit is 20'),
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a shift into the past or beyond the window, writing nothing', async () => {
    findMany.mockResolvedValueOnce([own(11, at(10, 7))]).mockResolvedValueOnce([]);

    await expect(
      shiftPlannerPosts({ ids: [11], deltaMinutes: -3 * 24 * 60, user: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('excludes the posts being moved from the existing set it validates against', async () => {
    findMany
      .mockResolvedValueOnce([own(11, at(10, 7)), own(13, at(12, 7))])
      .mockResolvedValueOnce([]);

    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      { id: 11, publishedAt: at(11, 7) },
      { id: 13, publishedAt: at(13, 7) },
    ]);

    await shiftPlannerPosts({ ids: [11, 13], deltaMinutes: 60, user: OWNER });

    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 7, id: { notIn: [11, 13] } }),
      })
    );
  });

  it('answers CONFLICT when a post went live before the write, after reindexing the ones that moved', async () => {
    findMany
      .mockResolvedValueOnce([own(11, at(10, 7)), own(13, at(12, 7))])
      .mockResolvedValueOnce([]);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 13, publishedAt: at(13, 7) }]);

    await expect(
      shiftPlannerPosts({ ids: [11, 13], deltaMinutes: 60, user: OWNER })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('1 of 2') });
    expect(dbMock.dbWrite.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postId: { in: [13] } } })
    );
  });
});

describe('getScheduledPosts', () => {
  const row = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    title: `Post ${id}`,
    publishedAt: scheduledAt,
    modelVersionId: null,
    nsfwLevel: 1,
    imageCount: 2,
    coverUrl: 'abc',
    coverType: 'image',
    versionStatus: null,
    versionName: null,
    modelName: null,
    modelStatus: null,
    modelUserId: null,
    ...extra,
  });

  it('maps rows, computes the release scope, and reports the cap and gap', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      row(1),
      row(2, {
        modelVersionId: 30,
        versionStatus: 'Scheduled',
        versionName: 'v2',
        modelName: 'Model',
        modelStatus: 'Published',
        modelUserId: 7,
      }),
      row(3, {
        modelVersionId: 31,
        versionStatus: 'Scheduled',
        versionName: 'v1',
        modelName: 'Other',
        modelStatus: 'Scheduled',
        modelUserId: 99,
        coverUrl: null,
        coverType: null,
      }),
    ]);

    const result = await getScheduledPosts({
      user: OWNER,
      from: new Date(),
      to: new Date(Date.now() + 30 * DAY),
    });

    expect(result.truncated).toBe(false);
    expect(result.dailyLimit).toBe(20);
    expect(result.minGapMinutes).toBe(30);
    expect(result.posts.map((post) => [post.id, post.release, post.cover])).toEqual([
      [1, null, { url: 'abc', type: 'image' }],
      [
        2,
        { scope: 'version', modelName: 'Model', versionName: 'v2' },
        { url: 'abc', type: 'image' },
      ],
      [3, null, null],
    ]);
    expect(result.posts[0].publishedAt).toBe(scheduledAt.toISOString());
  });

  it('scopes the query to the caller and counts the cover scan once', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);

    await getScheduledPosts({ user: OWNER, from: new Date(), to: new Date(Date.now() + DAY) });

    const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/WHERE p\."userId" = \?/);
    expect(values[0]).toBe(7);
    expect(sql.match(/FROM "Image"/g)).toHaveLength(1);
    expect(sql).not.toMatch(/"modelVersionId" = \?/);
  });

  it('adds the model-version filter only when asked', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);

    await getScheduledPosts({
      user: OWNER,
      from: new Date(),
      to: new Date(Date.now() + DAY),
      modelVersionId: 30,
    });

    const [, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    const fragment = values.find(
      (value): value is Sql => typeof value === 'object' && value !== null && 'strings' in value
    );
    expect(fragment?.strings.join('?')).toMatch(/AND p\."modelVersionId" = \?/);
    expect(fragment?.values).toEqual([30]);
  });

  it('fetches one past the page and flags truncation', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue(Array.from({ length: 1501 }, (_, i) => row(i + 1)));

    const result = await getScheduledPosts({
      user: OWNER,
      from: new Date(),
      to: new Date(Date.now() + 30 * DAY),
    });

    expect(result.truncated).toBe(true);
    expect(result.posts).toHaveLength(1500);
    const [strings, ...values] = dbMock.dbRead.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toMatch(/LIMIT \?\s*$/);
    expect(values.at(-1)).toBe(1501);
  });
});

describe('getPlannerPostDetail', () => {
  const editDetail = (overrides: Record<string, unknown> = {}) => ({
    id: 11,
    title: 'Post',
    detail: '<p>Hello <strong>there</strong> &amp; welcome</p><p>Second</p>',
    publishedAt: scheduledAt,
    modelVersionId: null,
    nsfwLevel: 1,
    user: { id: 7 },
    images: [],
    tags: [],
    tools: [],
    techniques: [],
    ...overrides,
  });

  it('refuses another user’s post even though the edit loader admits moderators', async () => {
    getPostEditDetail.mockResolvedValue(editDetail({ user: { id: 99 } }));

    await expect(
      getPlannerPostDetail({ id: 11, user: { ...OWNER, isModerator: true } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(getPostResources).not.toHaveBeenCalled();
  });

  it('returns the description as plain text and no stats while the post is scheduled', async () => {
    getPostEditDetail.mockResolvedValue(editDetail());

    const detail = await getPlannerPostDetail({ id: 11, user: OWNER });

    expect(detail.description).toBe('Hello there & welcome\nSecond');
    expect(detail.description).not.toMatch(/<[a-z]/);
    expect(detail.stats).toBeNull();
    expect(fetchStats).not.toHaveBeenCalled();
  });

  it('reads live engagement once the post is published', async () => {
    getPostEditDetail.mockResolvedValue(editDetail({ publishedAt: new Date(Date.now() - DAY) }));
    fetchStats.mockResolvedValue({
      11: { likeCount: 5, heartCount: 4, laughCount: 2, cryCount: 1, commentCount: 3 },
    });

    const detail = await getPlannerPostDetail({ id: 11, user: OWNER });

    expect(detail.stats).toEqual({ reactions: 12, comments: 3 });
  });
});

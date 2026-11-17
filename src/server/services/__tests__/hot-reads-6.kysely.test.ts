import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as PromotionService from '~/server/services/promotion.service';
import type * as ArticleService from '~/server/services/article.service';
import type * as GenerationService from '~/server/services/generation/generation.service';

// Any flag read on these paths answers false, so the associated-resources handler's own coverage
// flag reads false.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-6 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-6.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads6>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The lag decision, so a test can make it pick the primary and see the read follow it.
const { getDbWithoutLag, getKyselyWithoutLag } = vi.hoisted(() => ({
  getDbWithoutLag: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag,
  getKyselyWithoutLag,
}));
// What `getAssociatedResourcesCardDataHandler` does with the ids it read: the article ids reach
// `getArticles`, which is the observable here.
const { getArticles, getSponsoredModel, resolveCanGenerateForVersions } = vi.hoisted(() => ({
  getArticles: vi.fn(),
  getSponsoredModel: vi.fn(),
  resolveCanGenerateForVersions: vi.fn(),
}));
vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  getArticles,
}));
vi.mock('~/server/services/promotion.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PromotionService>()),
  getSponsoredModel,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  resolveCanGenerateForVersions,
}));

import * as queries from '@civitai/db-queries/hot-reads-6';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * Each hot-reads-6 call site: it reads through Kysely only, on the client the Prisma read used,
 * and returns a value that can only have come from the Kysely row (each fixture differs from any
 * default); the Prisma reads that still serve a path (an `undefined` Kysely answer's fallback, a
 * replica miss's primary read, the donation goals cache's primary reads) are pinned where they
 * run. Their rows, against a real database, are pinned in hot-reads-6.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct, and distinct from every count and id below.
const ID = 8301;
const USER = 8402;
const PRIMARY_USER = 8503;
const KYSELY_USER = 8604;
const ARTICLE = 8705;

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  expect(getKyselyWithoutLag).not.toHaveBeenCalled();
};

/** A `getUserWithCosmetics` row: the user, no picture, one equipped cosmetic. */
const userRow = (id: number) => ({
  id,
  username: `user-${id}`,
  deletedAt: null,
  image: null,
  profilePictureId: null,
  profilePictureName: null,
  profilePictureUrl: null,
  profilePictureNsfwLevel: null,
  profilePictureHash: null,
  profilePictureUserId: null,
  profilePictureIngestion: null,
  profilePictureType: null,
  profilePictureWidth: null,
  profilePictureHeight: null,
  profilePictureMetadata: null,
  cosmetics: [
    {
      data: { on: true },
      cosmeticId: 8806,
      cosmeticData: { url: 'c.png' },
      cosmeticType: 'Badge',
      cosmeticSource: 'Trophy',
      cosmeticName: 'Badge',
    },
  ],
});
const userPayload = (id: number) => ({
  id,
  username: `user-${id}`,
  deletedAt: null,
  image: null,
  profilePicture: null,
  cosmetics: [
    {
      data: { on: true },
      cosmetic: {
        id: 8806,
        data: { url: 'c.png' },
        type: 'Badge',
        source: 'Trophy',
        name: 'Badge',
      },
    },
  ],
});

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
  getArticles.mockReset().mockResolvedValue({ items: [] });
  getSponsoredModel.mockReset().mockResolvedValue(undefined);
  resolveCanGenerateForVersions.mockReset().mockResolvedValue({});
});

describe('control', () => {
  it('the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('getModelVersionOwnerHandler', () => {
  const load = async () =>
    (await import('~/server/controllers/model-version.controller')).getModelVersionOwnerHandler;

  it('one Kysely statement on the client the lag decision picks', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getModelVersionOwnerWithCosmetics.mockResolvedValue(userRow(KYSELY_USER) as never);
    await expect((await load())({ input: { id: ID } })).resolves.toStrictEqual(
      userPayload(KYSELY_USER)
    );
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('modelVersion', ID);
    expect(q.getModelVersionOwnerWithCosmetics.mock.calls).toEqual([[kyselyWrite, ID]]);
    expect(q.getModelVersionOwnerWithCosmetics.mock.calls[0][0]).toBe(kyselyWrite);
    expect(dbMock.dbRead.modelVersion.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.modelVersion.findUnique).not.toHaveBeenCalled();
  });

  it('no Kysely row runs the Prisma read, so a missing version is still not found', async () => {
    q.getModelVersionOwnerWithCosmetics.mockResolvedValue(undefined as never);
    dbMock.dbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect((await load())({ input: { id: ID } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbRead.modelVersion.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('getPostDetail', () => {
  const load = async () => (await import('~/server/services/post.service')).getPostDetail;
  const publishedAt = new Date('2026-01-01T00:00:00.000Z');
  const postRow = (title: string, published: Date | null) => ({
    id: ID,
    nsfw: false,
    nsfwLevel: 1,
    title,
    detail: null,
    modelVersionId: null,
    publishedModelVersionId: null,
    userId: KYSELY_USER,
    publishedAt: published,
    availability: 'Public',
    tags: [{ id: 8907, name: 'tag', isCategory: false }],
    collectionId: null,
  });

  it('the post and its user through Kysely, on the client the lag decision picks', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getPostDetailRow.mockResolvedValue(postRow('kysely', publishedAt) as never);
    q.getUserWithCosmetics.mockResolvedValue(userRow(KYSELY_USER) as never);
    const viewer = { id: USER, isModerator: false };
    const post = await (await load())({ id: ID, user: viewer as never });
    expect(post.title).toBe('kysely');
    expect(post.user).toStrictEqual(userPayload(KYSELY_USER));
    expect(post.tags).toStrictEqual([{ id: 8907, name: 'tag', isCategory: false }]);
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('post', ID);
    expect(q.getPostDetailRow.mock.calls[0][0]).toBe(kyselyWrite);
    expect(q.getPostDetailRow.mock.calls[0][1]).toMatchObject({ id: ID, viewer });
    expect(q.getUserWithCosmetics.mock.calls).toEqual([[kyselyWrite, KYSELY_USER]]);
    expect(dbMock.dbRead.post.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.post.findFirst).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
  });

  it('an unpublished post reads its unpublish context on the primary when Kysely picked it', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getPostDetailRow.mockResolvedValue(postRow('draft', null) as never);
    q.getUserWithCosmetics.mockResolvedValue(userRow(KYSELY_USER) as never);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await (
      await load()
    )({ id: ID });
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('a post whose user is gone runs the Prisma read on the replica', async () => {
    q.getPostDetailRow.mockResolvedValue(postRow('kysely', publishedAt) as never);
    q.getUserWithCosmetics.mockResolvedValue(undefined as never);
    dbMock.dbRead.post.findFirst.mockResolvedValue(null);
    await expect((await load())({ id: ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbRead.post.findFirst).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.post.findFirst.mock.calls[0][0].where).toMatchObject({ id: ID });
    expect(dbMock.dbWrite.post.findFirst).not.toHaveBeenCalled();
  });

  it('that Prisma read follows the lag decision to the primary', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getPostDetailRow.mockResolvedValue(postRow('kysely', publishedAt) as never);
    q.getUserWithCosmetics.mockResolvedValue(undefined as never);
    dbMock.dbWrite.post.findFirst.mockResolvedValue(null);
    await expect((await load())({ id: ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.post.findFirst).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.post.findFirst.mock.calls[0][0].where).toMatchObject({ id: ID });
    expect(dbMock.dbRead.post.findFirst).not.toHaveBeenCalled();
  });

  it('a missing post is not found, with no user read', async () => {
    q.getPostDetailRow.mockResolvedValue(undefined as never);
    await expect((await load())({ id: ID })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(q.getUserWithCosmetics).not.toHaveBeenCalled();
    expect(dbMock.dbRead.post.findFirst).not.toHaveBeenCalled();
  });
});

describe('findUserIdByUsername', () => {
  const load = async () => (await import('~/server/services/image.service')).findUserIdByUsername;

  it('the Kysely read on the replica', async () => {
    q.getUserIdByUsername.mockResolvedValue({ id: KYSELY_USER } as never);
    await expect((await load())('name')).resolves.toBe(KYSELY_USER);
    expect(q.getUserIdByUsername.mock.calls).toEqual([[kyselyRead, 'name']]);
    expect(q.getUserIdByUsername.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('a replica miss still falls back to the primary through Prisma', async () => {
    q.getUserIdByUsername.mockResolvedValue(undefined as never);
    dbMock.dbWrite.user.findUnique.mockResolvedValue({ id: PRIMARY_USER });
    await expect((await load())('name')).resolves.toBe(PRIMARY_USER);
    expect(dbMock.dbWrite.user.findUnique.mock.calls[0][0]).toEqual({
      where: { username: 'name' },
      select: { id: true },
    });
  });
});

describe('getUserBannedAtByUsername', () => {
  const load = async () =>
    (await import('~/server/services/user-banned-at.service')).getUserBannedAtByUsername;
  const bannedAt = new Date('2026-03-03T00:00:00.000Z');

  it('the Kysely read on the replica', async () => {
    q.listUserBannedAtByUsername.mockResolvedValue({ bannedAt } as never);
    await expect((await load())('name')).resolves.toStrictEqual({ bannedAt });
    expect(q.listUserBannedAtByUsername.mock.calls).toEqual([[kyselyRead, 'name']]);
    expect(q.listUserBannedAtByUsername.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
  });

  it('no such user is null', async () => {
    q.listUserBannedAtByUsername.mockResolvedValue(undefined as never);
    await expect((await load())('name')).resolves.toBeNull();
  });
});

describe('publicDonationGoalsLookupFn', () => {
  const load = async () =>
    (await import('~/server/redis/donation-goals-cache')).publicDonationGoalsLookupFn;
  const goal = (total: number) => ({
    id: 8908,
    goalAmount: 1000,
    title: 'goal',
    active: true,
    userId: USER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    description: null,
    entityId: ID,
    total,
  });
  const { total: _total, ...goalRow } = goal(0);

  it('the version and goal reads through Kysely, the totals through Prisma, on the replica', async () => {
    q.listExistingModelVersionIds.mockResolvedValue([{ id: ID }] as never);
    q.listActiveModelVersionDonationGoals.mockResolvedValue([
      { ...goalRow, title: 'kysely goal' },
    ] as never);
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ donationGoalId: 8908, total: 4321 }]);
    const { entityId: _e, ...expected } = goal(4321);
    await expect((await load())([ID])).resolves.toStrictEqual({
      [ID]: { modelVersionId: ID, goal: { ...expected, title: 'kysely goal' } },
    });
    expect(q.listExistingModelVersionIds.mock.calls).toEqual([[kyselyRead, [ID]]]);
    expect(q.listActiveModelVersionDonationGoals.mock.calls).toEqual([[kyselyRead, [ID]]]);
    expect(q.listExistingModelVersionIds.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.listActiveModelVersionDonationGoals.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.donationGoal.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('a version missing on the replica is still looked up on the primary through Prisma', async () => {
    q.listExistingModelVersionIds.mockResolvedValue([] as never);
    q.listActiveModelVersionDonationGoals.mockResolvedValue([] as never);
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: ID }]);
    await expect((await load())([ID])).resolves.toStrictEqual({
      [ID]: { modelVersionId: ID, goal: null },
    });
    expect(dbMock.dbWrite.modelVersion.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: [ID] } },
      select: { id: true },
    });
  });

  it('fromWrite: every read stays on the primary through Prisma, active goals only', async () => {
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: ID }]);
    dbMock.dbWrite.donationGoal.findMany.mockResolvedValue([goalRow]);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ donationGoalId: 8908, total: 1234 }]);
    const { entityId: _e, ...expected } = goal(1234);
    await expect((await load())([ID], true)).resolves.toStrictEqual({
      [ID]: { modelVersionId: ID, goal: expected },
    });
    expect(dbMock.dbWrite.donationGoal.findMany.mock.calls[0][0].where).toEqual({
      entityType: 'ModelVersion',
      entityId: { in: [ID] },
      active: true,
    });
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.donationGoal.findMany).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

describe('getUserEngagedModelVersions', () => {
  const load = async () =>
    (await import('~/server/services/user.service')).getUserEngagedModelVersions;

  it('the Kysely read on the replica, a single id as a list', async () => {
    q.listModelVersionEngagements.mockResolvedValue([
      { modelVersionId: KYSELY_USER, type: 'Notify' },
    ] as never);
    await expect((await load())({ userId: USER, modelVersionIds: ID })).resolves.toEqual([
      { modelVersionId: KYSELY_USER, type: 'Notify' },
    ]);
    expect(q.listModelVersionEngagements.mock.calls).toEqual([
      [kyselyRead, { userId: USER, modelVersionIds: [ID] }],
    ]);
    expect(q.listModelVersionEngagements.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.modelVersionEngagement.findMany).not.toHaveBeenCalled();
  });
});

describe('getResourceReviewsByUserId', () => {
  const load = async () =>
    (await import('~/server/services/resourceReview.service')).getResourceReviewsByUserId;

  it('the Kysely read on the replica, with the filters the Prisma read had', async () => {
    q.listUserRecommendedReviews.mockResolvedValue([
      { modelId: KYSELY_USER, modelVersionId: 2 },
    ] as never);
    await expect(
      (
        await load()
      )({ userId: USER, recommended: true, modelIds: [ID] })
    ).resolves.toEqual([{ modelId: KYSELY_USER, modelVersionId: 2 }]);
    expect(q.listUserRecommendedReviews.mock.calls).toEqual([
      [kyselyRead, { userId: USER, recommended: true, modelIds: [ID] }],
    ]);
    expect(q.listUserRecommendedReviews.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.resourceReview.findMany).not.toHaveBeenCalled();
  });
});

describe('getAssociatedResourcesCardDataHandler (the associated ids)', () => {
  const load = async () =>
    (await import('~/server/controllers/model.controller')).getAssociatedResourcesCardDataHandler;
  const call = async () =>
    (await load())({
      input: { fromId: ID, type: 'Suggested' } as never,
      ctx: { user: undefined, features: {} } as never,
    });

  it('the Kysely read on the replica, whose article ids are fetched', async () => {
    q.listModelAssociationTargets.mockResolvedValue([
      { toModelId: null, toArticleId: ARTICLE },
    ] as never);
    await call();
    expect(q.listModelAssociationTargets.mock.calls).toEqual([
      [kyselyRead, { fromModelId: ID, type: 'Suggested' }],
    ]);
    expect(q.listModelAssociationTargets.mock.calls[0][0]).toBe(kyselyRead);
    expect(getArticles.mock.calls[0][0].ids).toEqual([ARTICLE]);
    expect(dbMock.dbRead.modelAssociations.findMany).not.toHaveBeenCalled();
  });
});

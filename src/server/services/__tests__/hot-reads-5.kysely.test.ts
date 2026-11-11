import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// Any flag read on these paths answers false, without a Flipt client.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-5 statement stubbed: their rows, against a real database, are pinned in
// hot-reads-5.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads5>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The engagement read `getUserEngagedModelVersionsHandler` makes after the version ids, so that
// case reaches no database.
const { listModelVersionEngagements } = vi.hoisted(() => ({
  listModelVersionEngagements: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  listModelVersionEngagements,
}));
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

import * as queries from '@civitai/db-queries/hot-reads-5';
import { dbMock, redisMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * Each hot-reads-5 call site reads through Kysely only, on the client the Prisma read used
 * (`kyselyRead` for a `dbRead` read, the `getKyselyWithoutLag` twin of a `getDbWithoutLag` read),
 * and returns the mapped Prisma payload. The Prisma reads that still serve a path are pinned here
 * too: a review read inside a caller's transaction, and the home block's fallback to the primary.
 * Their rows, against a real database, are pinned in hot-reads-5.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// Pairwise distinct, and distinct from every count and id below.
const ID = 7301;
const USER = 7402;
const OWNER = 7503;
const POST = 7604;
const COUNT = 13;

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  expect(getKyselyWithoutLag).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  listModelVersionEngagements.mockReset().mockResolvedValue([]);
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
});

describe('control', () => {
  it('the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('getPlacementConfig (KeyValue)', () => {
  const load = async () => (await import('~/server/services/placement.service')).getPlacementConfig;

  // The stored value differs from the default: the assertion names the read used.
  it('one Kysely read on the replica, whose value configures the result', async () => {
    const getPlacementConfig = await load();
    q.getKeyValue.mockResolvedValue({
      key: 'placement:config',
      value: { expiryHours: { sticker: 31 } },
    } as never);
    const config = await getPlacementConfig();
    expect(q.getKeyValue.mock.calls).toEqual([[kyselyRead, 'placement:config']]);
    expect(q.getKeyValue.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.keyValue.findUnique).not.toHaveBeenCalled();
    expect(config.expiryHours('sticker')).toBe(31);
  });

  it('a missing row leaves the compiled default', async () => {
    const getPlacementConfig = await load();
    q.getKeyValue.mockResolvedValue(undefined as never);
    const config = await getPlacementConfig();
    expect(config.expiryHours('sticker')).toBe(48);
  });
});

describe('getAnnouncementMinScore (KeyValue)', () => {
  const load = async () =>
    (await import('~/server/services/announcement-allowance.service')).getAnnouncementMinScore;

  it('one Kysely read on the replica, whose value is the answer', async () => {
    q.getKeyValue.mockResolvedValue({
      key: 'announcements:config',
      value: { minScore: 8765 },
    } as never);
    await expect((await load())()).resolves.toBe(8765);
    expect(q.getKeyValue.mock.calls).toEqual([[kyselyRead, 'announcements:config']]);
    expect(q.getKeyValue.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.keyValue.findUnique).not.toHaveBeenCalled();
  });
});

describe('getVisibleModel3DIdForPost', () => {
  const load = async () =>
    (await import('~/server/services/model3d.service')).getVisibleModel3DIdForPost;

  it('one Kysely statement on the replica, mapped to the Prisma payload', async () => {
    q.getPostModel3d.mockResolvedValue({
      postId: POST,
      model3dRowId: ID,
      model3dUserId: OWNER,
      model3dStatus: 'Published',
      model3dDeletedAt: null,
    } as never);
    await expect((await load())({ postId: POST, userId: USER })).resolves.toBe(ID);
    expect(q.getPostModel3d.mock.calls).toEqual([[kyselyRead, POST]]);
    expect(q.getPostModel3d.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.post.findUnique).not.toHaveBeenCalled();
  });

  it('a hidden Model3D is still refused', async () => {
    q.getPostModel3d.mockResolvedValue({
      postId: POST,
      model3dRowId: ID,
      model3dUserId: OWNER,
      model3dStatus: 'Draft',
      model3dDeletedAt: null,
    } as never);
    await expect((await load())({ postId: POST, userId: USER })).resolves.toBeNull();
  });
});

describe('getDismissedAnnouncementIds', () => {
  const load = async () =>
    (await import('~/server/services/announcement.service')).getDismissedAnnouncementIds;

  it('the Kysely read on the replica, with the domain and both its values', async () => {
    q.listDismissedAnnouncementIds.mockResolvedValue([{ announcementId: ID }] as never);
    await expect((await load())({ userId: USER, domain: 'red' as never })).resolves.toEqual([ID]);
    const [[db, input]] = q.listDismissedAnnouncementIds.mock.calls;
    expect(db).toBe(kyselyRead);
    expect(input).toEqual({ userId: USER, now: expect.any(Date), domains: ['all', 'red'] });
    expect(dbMock.dbRead.announcementDismissal.findMany).not.toHaveBeenCalled();
  });

  it('no domain filter without a domain', async () => {
    q.listDismissedAnnouncementIds.mockResolvedValue([] as never);
    await (
      await load()
    )({ userId: USER });
    expect(q.listDismissedAnnouncementIds.mock.calls[0][1].domains).toBeUndefined();
  });
});

describe('getEntityCollaborators', () => {
  const load = async () =>
    (await import('~/server/services/entity-collaborator.service')).getEntityCollaborators;
  const collaboratorUser = { id: USER, username: 'collab', cosmetics: [] };

  it('one Kysely statement on the replica, the users through Prisma, and the same filter', async () => {
    q.listPostCollaborators.mockResolvedValue([
      {
        postUserId: OWNER,
        collaboratorUserId: USER,
        entityId: POST,
        entityType: 'Post',
        status: 'Pending',
      },
    ] as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([collaboratorUser]);
    // A pending collaborator is visible to the post owner, not to a signed-out viewer.
    await expect((await load())({ entityId: POST, entityType: 'Post' })).resolves.toEqual([]);
    await expect(
      (
        await load()
      )({ entityId: POST, entityType: 'Post', userId: OWNER })
    ).resolves.toEqual([
      { user: collaboratorUser, entityId: POST, entityType: 'Post', status: 'Pending' },
    ]);
    expect(q.listPostCollaborators.mock.calls[0]).toEqual([kyselyRead, POST]);
    expect(q.listPostCollaborators.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.post.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbRead.entityCollaborator.findMany).not.toHaveBeenCalled();
    expect(dbMock.dbRead.user.findMany.mock.calls[0][0].where).toEqual({ id: { in: [USER] } });
  });

  it('a missing post is an empty list, with no user read', async () => {
    q.listPostCollaborators.mockResolvedValue([] as never);
    await expect((await load())({ entityId: POST, entityType: 'Post' })).resolves.toEqual([]);
    expect(dbMock.dbRead.user.findMany).not.toHaveBeenCalled();
  });
});

describe('getHomeBlockById', () => {
  const load = async () => (await import('~/server/services/home-block.service')).getHomeBlockById;
  const read = async () =>
    (await load())({ id: ID, viewer: {} as never } as never).catch(() => undefined);

  it('the Kysely read on the replica, no Prisma read for a row it finds', async () => {
    q.getHomeBlockRow.mockResolvedValue({
      id: ID,
      metadata: {},
      type: 'Announcement',
      userId: OWNER,
      sourceId: null,
    } as never);
    await read();
    expect(q.getHomeBlockRow.mock.calls).toEqual([[kyselyRead, ID]]);
    expect(q.getHomeBlockRow.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.homeBlock.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.homeBlock.findUnique).not.toHaveBeenCalled();
  });

  it('a row missing on the replica falls back to the primary through Prisma', async () => {
    q.getHomeBlockRow.mockResolvedValue(undefined as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUnique.mock.calls[0][0]).toEqual({
      select: { id: true, metadata: true, type: true, userId: true, sourceId: true },
      where: { id: ID },
    });
    expect(dbMock.dbRead.homeBlock.findUnique).not.toHaveBeenCalled();
  });

  it('a replica error falls back to the primary through Prisma', async () => {
    q.getHomeBlockRow.mockRejectedValue(new Error('replica down') as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('countUnclaimedPrizes', () => {
  const load = async () => (await import('~/server/services/prize.service')).countUnclaimedPrizes;

  it('the Kysely count on the replica', async () => {
    q.countUnclaimedPrizes.mockResolvedValue(COUNT as never);
    await expect((await load())(USER)).resolves.toBe(COUNT);
    expect(q.countUnclaimedPrizes.mock.calls).toEqual([[kyselyRead, USER]]);
    expect(q.countUnclaimedPrizes.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.prize.count).not.toHaveBeenCalled();
  });
});

describe('getUserResourceReview', () => {
  const load = async () =>
    (await import('~/server/services/resourceReview.service')).getUserResourceReview;
  const review = { id: ID, modelId: 1, modelVersionId: 2, recommended: true };

  it('the Kysely read on the client the lag decision picks', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.listUserResourceReviews.mockResolvedValue([review] as never);
    await expect((await load())({ modelId: 1, userId: USER })).resolves.toEqual([review]);
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('resourceReview', USER);
    expect(q.listUserResourceReviews.mock.calls).toEqual([
      [kyselyWrite, { modelId: 1, modelVersionId: undefined, userId: USER }],
    ]);
    expect(q.listUserResourceReviews.mock.calls[0][0]).toBe(kyselyWrite);
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    expect(dbMock.dbRead.resourceReview.findMany).not.toHaveBeenCalled();
  });

  it('with a caller-provided client: Prisma on that client, never Kysely', async () => {
    const tx = { resourceReview: { findMany: vi.fn(async () => [review]) } };
    await (
      await load()
    )({ modelId: 1, userId: USER, tx: tx as never });
    expect(tx.resourceReview.findMany).toHaveBeenCalledTimes(1);
    expect(tx.resourceReview.findMany.mock.calls[0]).toMatchObject([
      { where: { modelId: 1, userId: USER } },
    ]);
    expect(getDbWithoutLag).not.toHaveBeenCalled();
    expect(dbMock.dbRead.resourceReview.findMany).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

describe('getFileForModelVersion (the version and its model)', () => {
  const load = async () => (await import('~/server/services/file.service')).getFileForModelVersion;
  // A missing version: the resolution stops at the not-found answer, after the one read.
  const resolve = async () =>
    (await load())({
      modelVersionId: ID,
      attribution: { path: 'test' } as never,
      redCapable: true,
    });

  it('one Kysely statement on the replica', async () => {
    q.getModelVersionForFile.mockResolvedValue(undefined as never);
    await expect(resolve()).resolves.toEqual({ status: 'not-found' });
    expect(q.getModelVersionForFile.mock.calls).toEqual([[kyselyRead, ID]]);
    expect(q.getModelVersionForFile.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.modelVersion.findFirst).not.toHaveBeenCalled();
  });
});

describe('getModelCollectionShowcaseHandler (the model meta)', () => {
  const load = async () =>
    (await import('~/server/controllers/model.controller')).getModelCollectionShowcaseHandler;

  it('the Kysely read on the client the lag decision picks', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getModelMeta.mockResolvedValue({ id: ID, meta: {} } as never);
    await expect((await load())({ input: { id: ID } })).resolves.toBeNull();
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('model', ID);
    expect(q.getModelMeta.mock.calls).toEqual([[kyselyWrite, ID]]);
    expect(q.getModelMeta.mock.calls[0][0]).toBe(kyselyWrite);
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
  });

  it('a missing model is still a not-found error', async () => {
    q.getModelMeta.mockResolvedValue(undefined as never);
    await expect((await load())({ input: { id: ID } })).rejects.toThrow(`No model with id ${ID}`);
  });
});

describe('getUserEngagedModelVersionsHandler (the version ids)', () => {
  const load = async () =>
    (await import('~/server/controllers/user.controller')).getUserEngagedModelVersionsHandler;
  const call = async () =>
    (await load())({ input: { id: ID }, ctx: { user: { id: USER } } as never }).catch(
      () => undefined
    );

  it('the Kysely read on the replica, whose ids the engagement read takes', async () => {
    q.listModelVersionIds.mockResolvedValue([{ id: 1 }] as never);
    await call();
    expect(q.listModelVersionIds.mock.calls).toEqual([[kyselyRead, ID]]);
    expect(q.listModelVersionIds.mock.calls[0][0]).toBe(kyselyRead);
    expect(listModelVersionEngagements.mock.calls[0][1]).toMatchObject({ modelVersionIds: [1] });
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });
});

describe("toggleReaction (the image reaction's existence check)", () => {
  const load = async () => (await import('~/server/services/reaction.service')).toggleReaction;
  const toggle = async () =>
    (await load())({
      entityType: 'image',
      entityId: ID,
      userId: USER,
      reaction: 'Like',
      eventPoints: false,
    } as never).catch(() => undefined);

  beforeEach(() => {
    redisMock.redis.set.mockResolvedValue('OK');
  });

  it('the Kysely read on the client the lag decision picks', async () => {
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getImageReactionId.mockResolvedValue({ id: 1 } as never);
    await toggle();
    expect(getKyselyWithoutLag).toHaveBeenCalledWith();
    expect(q.getImageReactionId.mock.calls).toEqual([
      [kyselyWrite, { userId: USER, reaction: 'Like', imageId: ID }],
    ]);
    expect(q.getImageReactionId.mock.calls[0][0]).toBe(kyselyWrite);
    expect(dbMock.dbRead.imageReaction.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageReaction.findFirst).not.toHaveBeenCalled();
  });
});

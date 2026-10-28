import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-5 statement stubbed: their rows against Prisma's are compared in
// hot-reads-5.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads5>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The lag decision, so a test can make it pick the primary and see both paths follow it.
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
 * Each call site behind `kysely-hot-reads-5`: the flag is evaluated by its key, with no entity or
 * context, once per call; OFF reads through Prisma only, exactly as before; ON reads through
 * Kysely only, on the client the Prisma read used (`kyselyRead` for a `dbRead` read, the
 * `getKyselyWithoutLag` twin of a `getDbWithoutLag` read), and returns the mapped Prisma payload.
 * Row parity against a real database is in hot-reads-5.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));
const FLAG = 'kysely-hot-reads-5';

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

  // `sticker` defaults to 48 expiry hours; each path's stored value (29, 31) differs from it
  // and from the other, so the assertion names which read configured the result.
  it('OFF: one Prisma read on the replica, whose value configures the result', async () => {
    const getPlacementConfig = await load();
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'placement:config',
      value: { expiryHours: { sticker: 29 } },
    });
    const config = await getPlacementConfig();
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.keyValue.findUnique.mock.calls).toEqual([
      [{ where: { key: 'placement:config' } }],
    ]);
    expect(dbMock.dbWrite.keyValue.findUnique).not.toHaveBeenCalled();
    expectNoKyselyRead();
    expect(config.expiryHours('sticker')).toBe(29);
  });

  it('ON: one Kysely read on the replica, whose value configures the result', async () => {
    const getPlacementConfig = await load();
    flag.mockResolvedValue(true);
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

  it('ON: a missing Kysely row leaves the compiled default', async () => {
    const getPlacementConfig = await load();
    flag.mockResolvedValue(true);
    q.getKeyValue.mockResolvedValue(undefined as never);
    const config = await getPlacementConfig();
    expect(config.expiryHours('sticker')).toBe(48);
  });
});

describe('getAnnouncementMinScore (KeyValue)', () => {
  const load = async () =>
    (await import('~/server/services/announcement-allowance.service')).getAnnouncementMinScore;

  it('OFF: one Prisma read on the replica', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({
      key: 'announcements:config',
      value: { minScore: 4321 },
    });
    await expect((await load())()).resolves.toBe(4321);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.keyValue.findUnique.mock.calls).toEqual([
      [{ where: { key: 'announcements:config' } }],
    ]);
    expectNoKyselyRead();
  });

  it('ON: one Kysely read on the replica, whose value is the answer', async () => {
    flag.mockResolvedValue(true);
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
  const model3d = { id: ID, userId: OWNER, status: 'Published', deletedAt: null };

  it('OFF: the Prisma read on the replica', async () => {
    dbMock.dbRead.post.findUnique.mockResolvedValue({ model3d });
    await expect((await load())({ postId: POST, userId: USER })).resolves.toBe(ID);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.post.findUnique).toHaveBeenCalledTimes(1);
    expectNoKyselyRead();
  });

  it('ON: one Kysely statement on the replica, mapped to the Prisma payload', async () => {
    flag.mockResolvedValue(true);
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

  it('ON: a hidden Model3D is still refused', async () => {
    flag.mockResolvedValue(true);
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

  it('OFF: the Prisma read on the replica', async () => {
    dbMock.dbRead.announcementDismissal.findMany.mockResolvedValue([{ announcementId: ID }]);
    await expect((await load())({ userId: USER })).resolves.toEqual([ID]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.announcementDismissal.findMany).toHaveBeenCalledTimes(1);
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the replica, with the domain and both its values', async () => {
    flag.mockResolvedValue(true);
    q.listDismissedAnnouncementIds.mockResolvedValue([{ announcementId: ID }] as never);
    await expect((await load())({ userId: USER, domain: 'red' as never })).resolves.toEqual([ID]);
    const [[db, input]] = q.listDismissedAnnouncementIds.mock.calls;
    expect(db).toBe(kyselyRead);
    expect(input).toEqual({ userId: USER, now: expect.any(Date), domains: ['all', 'red'] });
    expect(dbMock.dbRead.announcementDismissal.findMany).not.toHaveBeenCalled();
  });

  it('ON: no domain filter without a domain', async () => {
    flag.mockResolvedValue(true);
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

  it('OFF: the two Prisma reads on the replica', async () => {
    dbMock.dbRead.post.findUnique.mockResolvedValue({ userId: OWNER });
    dbMock.dbRead.entityCollaborator.findMany.mockResolvedValue([
      { user: collaboratorUser, entityId: POST, entityType: 'Post', status: 'Approved' },
    ]);
    const result = await (await load())({ entityId: POST, entityType: 'Post' });
    expect(result).toEqual([
      { user: collaboratorUser, entityId: POST, entityType: 'Post', status: 'Approved' },
    ]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expectNoKyselyRead();
  });

  it('ON: one Kysely statement on the replica, the users through Prisma, and the same filter', async () => {
    flag.mockResolvedValue(true);
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

  it('ON: a missing post is an empty list, with no user read', async () => {
    flag.mockResolvedValue(true);
    q.listPostCollaborators.mockResolvedValue([] as never);
    await expect((await load())({ entityId: POST, entityType: 'Post' })).resolves.toEqual([]);
    expect(dbMock.dbRead.user.findMany).not.toHaveBeenCalled();
  });
});

describe('getHomeBlockById', () => {
  const load = async () => (await import('~/server/services/home-block.service')).getHomeBlockById;
  const read = async () =>
    (await load())({ id: ID, viewer: {} as never } as never).catch(() => undefined);

  it('OFF: the Prisma read on the replica', async () => {
    await read();
    expect(flag.mock.calls[0]).toEqual([FLAG]);
    expect(dbMock.dbRead.homeBlock.findUniqueOrThrow.mock.calls[0][0]).toEqual({
      select: { id: true, metadata: true, type: true, userId: true, sourceId: true },
      where: { id: ID },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the replica, no Prisma read for a row it finds', async () => {
    flag.mockResolvedValue(true);
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
    expect(dbMock.dbRead.homeBlock.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.homeBlock.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('ON: a row missing on the replica falls back to the primary through Prisma', async () => {
    flag.mockResolvedValue(true);
    q.getHomeBlockRow.mockResolvedValue(undefined as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUniqueOrThrow.mock.calls[0][0]).toEqual({
      select: { id: true, metadata: true, type: true, userId: true, sourceId: true },
      where: { id: ID },
    });
  });

  it('ON: a replica error falls back to the primary through Prisma, as before', async () => {
    flag.mockResolvedValue(true);
    q.getHomeBlockRow.mockRejectedValue(new Error('replica down') as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('countUnclaimedPrizes', () => {
  const load = async () => (await import('~/server/services/prize.service')).countUnclaimedPrizes;

  it('OFF: the Prisma count on the replica', async () => {
    dbMock.dbRead.prize.count.mockResolvedValue(COUNT);
    await expect((await load())(USER)).resolves.toBe(COUNT);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.prize.count.mock.calls).toEqual([
      [{ where: { userId: USER, claimedAt: null, voidedAt: null } }],
    ]);
    expectNoKyselyRead();
  });

  it('ON: the Kysely count on the replica', async () => {
    flag.mockResolvedValue(true);
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

  it('OFF: the Prisma read on the client the lag decision picked', async () => {
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([review]);
    await expect((await load())({ modelId: 1, userId: USER })).resolves.toEqual([review]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(getDbWithoutLag).toHaveBeenCalledWith('resourceReview', USER);
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the client the same lag decision picks', async () => {
    flag.mockResolvedValue(true);
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

  it('ON with a caller-provided client: Prisma on that client, never Kysely', async () => {
    flag.mockResolvedValue(true);
    const tx = { resourceReview: { findMany: vi.fn(async () => [review]) } };
    await (
      await load()
    )({ modelId: 1, userId: USER, tx: tx as never });
    expect(tx.resourceReview.findMany).toHaveBeenCalledTimes(1);
    expect(flag).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

describe('getFileForModelVersion (the version and its model)', () => {
  const load = async () => (await import('~/server/services/file.service')).getFileForModelVersion;
  // A missing version: both paths stop at the not-found answer, after the one read.
  const resolve = async () =>
    (await load())({ modelVersionId: ID, attribution: { path: 'test' } as never });

  it('OFF: the Prisma read on the replica', async () => {
    await expect(resolve()).resolves.toEqual({ status: 'not-found' });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.modelVersion.findFirst.mock.calls[0][0].where).toEqual({
      id: ID,
      model: { is: {} },
    });
    expectNoKyselyRead();
  });

  it('ON: one Kysely statement on the replica', async () => {
    flag.mockResolvedValue(true);
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

  it('OFF: the Prisma read on the client the lag decision picked', async () => {
    dbMock.dbRead.model.findFirst.mockResolvedValue({ id: ID, meta: {} });
    await expect((await load())({ input: { id: ID } })).resolves.toBeNull();
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(getDbWithoutLag).toHaveBeenCalledWith('model', ID);
    expect(dbMock.dbRead.model.findFirst.mock.calls[0][0]).toEqual({
      where: { id: ID },
      select: { id: true, meta: true },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the client the same lag decision picks', async () => {
    flag.mockResolvedValue(true);
    getKyselyWithoutLag.mockResolvedValue(kyselyWrite);
    q.getModelMeta.mockResolvedValue({ id: ID, meta: {} } as never);
    await expect((await load())({ input: { id: ID } })).resolves.toBeNull();
    expect(getKyselyWithoutLag).toHaveBeenCalledWith('model', ID);
    expect(q.getModelMeta.mock.calls).toEqual([[kyselyWrite, ID]]);
    expect(q.getModelMeta.mock.calls[0][0]).toBe(kyselyWrite);
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
    expect(getDbWithoutLag).not.toHaveBeenCalled();
  });

  it('ON: a missing model is still a not-found error', async () => {
    flag.mockResolvedValue(true);
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

  it('OFF: the Prisma read on the replica', async () => {
    await call();
    expect(flag.mock.calls[0]).toEqual([FLAG]);
    expect(dbMock.dbRead.modelVersion.findMany.mock.calls[0][0]).toEqual({
      where: { modelId: ID },
      select: { id: true },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the replica', async () => {
    flag.mockResolvedValue(true);
    q.listModelVersionIds.mockResolvedValue([{ id: 1 }] as never);
    await call();
    expect(q.listModelVersionIds.mock.calls).toEqual([[kyselyRead, ID]]);
    expect(q.listModelVersionIds.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalledWith({
      where: { modelId: ID },
      select: { id: true },
    });
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

  it('OFF: the Prisma read on the client the lag decision picked', async () => {
    await toggle();
    expect(flag.mock.calls[0]).toEqual([FLAG]);
    expect(getDbWithoutLag).toHaveBeenCalledWith();
    expect(dbMock.dbRead.imageReaction.findFirst.mock.calls[0][0]).toEqual({
      where: { userId: USER, reaction: 'Like', imageId: ID },
      select: { id: true },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely read on the client the same lag decision picks', async () => {
    flag.mockResolvedValue(true);
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads8 from '@civitai/db-queries/hot-reads-8';
import type * as DonationGoalService from '~/server/services/donation-goal.service';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-8 statement stubbed: their rows against Prisma's are compared in
// hot-reads-8.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-8', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads8>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// Where `modelVersionDonationGoal` goes once it knows the version's owner: the owner's goals, or the
// public ones. Which of the two is called is the observable of the owner id it read.
const { getDonationGoals, getOwnerDonationGoals } = vi.hoisted(() => ({
  getDonationGoals: vi.fn(),
  getOwnerDonationGoals: vi.fn(),
}));
vi.mock('~/server/services/donation-goal.service', async (importOriginal) => ({
  ...(await importOriginal<typeof DonationGoalService>()),
  getDonationGoals,
  getOwnerDonationGoals,
}));

import * as queries from '@civitai/db-queries/hot-reads-8';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { NsfwLevel } from '~/server/common/enums';

/**
 * Each call site behind `kysely-hot-reads-8`: the flag is evaluated by its key, with no entity or
 * context, once per call; OFF reads through Prisma only, exactly as before; ON reads through
 * Kysely on the replica client and returns a value that can only have come from the Kysely rows
 * (each ON fixture differs from the OFF one). Row parity against a real database is in
 * hot-reads-8.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));
const FLAG = 'kysely-hot-reads-8';

// Pairwise distinct, and distinct from every level, depth and count below.
const POST = 9101;
const POST_2 = 9102;
const ROOT_POST = 9103;
const CHAPTER_OFF = 9201;
const CHAPTER_ON = 9202;
const ROOT_CHAPTER = 9203;
const STORY = 9301;
const OWNER = 9401;
const AUTHOR = 9402;
const VIEWER = 9403;
const VERSION = 9501;
const MODEL = 9601;
const COSMETIC = 9701;

const notBanned = { bannedAt: null, deletedAt: null };

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDonationGoals.mockReset().mockResolvedValue({ [VERSION]: null });
  getOwnerDonationGoals.mockReset().mockResolvedValue({ [VERSION]: null });
});

describe('control', () => {
  it('the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('getStorylinesForPosts', () => {
  const load = async () =>
    (await import('~/server/services/storyline.service')).getStorylinesForPosts;
  // A public story the anonymous reader may open, so the chapter reaches the result.
  const storyline = {
    id: STORY,
    title: 'A story',
    userId: OWNER,
    maxNsfwLevel: NsfwLevel.R,
    minorByScan: false,
    tosViolation: false,
    nsfwLevel: 0,
    moderatorNsfwLevel: null,
    user: notBanned,
    chapters: [
      {
        id: ROOT_CHAPTER,
        postId: ROOT_POST,
        removedAt: null,
        post: {
          nsfwLevel: NsfwLevel.PG,
          publishedAt: new Date(0),
          tosViolation: false,
          user: notBanned,
        },
      },
    ],
  };
  const chapterRow = (id: number, depth: number) => ({
    id,
    postId: POST,
    depth,
    removedAt: null,
    post: { nsfwLevel: NsfwLevel.PG, userId: AUTHOR, tosViolation: false, user: notBanned },
    storyline,
  });
  const read = async () =>
    (await load())({ postIds: [POST, POST_2], viewer: undefined, browsingLevel: NsfwLevel.PG });

  it('OFF: one Prisma read on the replica', async () => {
    dbMock.dbRead.storylineChapter.findMany.mockResolvedValue([
      chapterRow(CHAPTER_OFF, 2),
    ] as never);
    await expect(read()).resolves.toEqual({
      [POST]: { chapterId: CHAPTER_OFF, depth: 2, storylineId: STORY, title: 'A story' },
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.storylineChapter.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.storylineChapter.findMany.mock.calls[0][0]).toMatchObject({
      where: { postId: { in: [POST, POST_2] } },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely reads on the replica, whose rows are the result', async () => {
    flag.mockResolvedValue(true);
    q.listStorylineChaptersByPostIds.mockResolvedValue([
      { id: CHAPTER_ON, postId: POST, depth: 3, removedAt: null, storylineId: STORY },
    ] as never);
    q.listStorylinesWithOwner.mockResolvedValue([
      {
        id: STORY,
        title: 'On title',
        userId: OWNER,
        maxNsfwLevel: NsfwLevel.R,
        minorByScan: false,
        tosViolation: false,
        nsfwLevel: 0,
        moderatorNsfwLevel: null,
        ownerBannedAt: null,
        ownerDeletedAt: null,
      },
    ] as never);
    q.listStorylineRootChapters.mockResolvedValue([
      { id: ROOT_CHAPTER, postId: ROOT_POST, removedAt: null, storylineId: STORY },
    ] as never);
    q.listStorylinePostsWithAuthor.mockResolvedValue([
      {
        id: POST,
        nsfwLevel: NsfwLevel.PG,
        userId: AUTHOR,
        tosViolation: false,
        publishedAt: new Date(0),
        authorBannedAt: null,
        authorDeletedAt: null,
      },
      {
        id: ROOT_POST,
        nsfwLevel: NsfwLevel.PG,
        userId: OWNER,
        tosViolation: false,
        publishedAt: new Date(0),
        authorBannedAt: null,
        authorDeletedAt: null,
      },
    ] as never);
    await expect(read()).resolves.toEqual({
      [POST]: { chapterId: CHAPTER_ON, depth: 3, storylineId: STORY, title: 'On title' },
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(q.listStorylineChaptersByPostIds.mock.calls).toEqual([[kyselyRead, [POST, POST_2]]]);
    expect(q.listStorylineChaptersByPostIds.mock.calls[0][0]).toBe(kyselyRead);
    expect(q.listStorylinesWithOwner.mock.calls).toEqual([[kyselyRead, [STORY]]]);
    expect(q.listStorylineRootChapters.mock.calls).toEqual([[kyselyRead, [STORY]]]);
    expect(q.listStorylinePostsWithAuthor.mock.calls).toEqual([[kyselyRead, [POST, ROOT_POST]]]);
    expect(dbMock.dbRead.storylineChapter.findMany).not.toHaveBeenCalled();
  });

  it('ON, no post is a chapter: one Kysely statement and nothing else', async () => {
    flag.mockResolvedValue(true);
    q.listStorylineChaptersByPostIds.mockResolvedValue([] as never);
    await expect(read()).resolves.toEqual({});
    expect(q.listStorylineChaptersByPostIds).toHaveBeenCalledTimes(1);
    expect(q.listStorylinesWithOwner).not.toHaveBeenCalled();
    expect(q.listStorylineRootChapters).not.toHaveBeenCalled();
    expect(q.listStorylinePostsWithAuthor).not.toHaveBeenCalled();
  });

  it('no post ids reads nothing and evaluates no flag', async () => {
    await expect(
      (
        await load()
      )({ postIds: [], viewer: undefined, browsingLevel: NsfwLevel.PG })
    ).resolves.toEqual({});
    expect(flag).not.toHaveBeenCalled();
    expect(dbMock.dbRead.storylineChapter.findMany).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

describe('getUserCosmetics', () => {
  const load = async () => (await import('~/server/services/user.service')).getUserCosmetics;
  const cosmetic = (name: string) => ({
    id: COSMETIC,
    name,
    description: null,
    type: 'Badge',
    source: 'Claim',
    data: {},
    createdById: null,
    flags: 0,
  });
  const userCosmetic = (name: string) => ({
    obtainedAt: new Date(0),
    equippedAt: null,
    equippedToId: null,
    equippedToType: null,
    forId: null,
    forType: null,
    claimKey: 'claimed',
    data: null,
    cosmetic: cosmetic(name),
  });

  it.each([
    ['all of them', false, undefined],
    ['the equipped ones', true, { equippedAt: { not: null } }],
  ])('OFF (%s): one Prisma read on the replica', async (_, equipped, where) => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({ cosmetics: [userCosmetic('off')] } as never);
    await expect((await load())({ userId: VIEWER, equipped })).resolves.toEqual({
      cosmetics: [userCosmetic('off')],
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    const args = dbMock.dbRead.user.findUnique.mock.calls[0][0] as {
      where: unknown;
      select: { cosmetics: { where: unknown; select: { cosmetic: unknown } } };
    };
    expect(args.where).toEqual({ id: VIEWER });
    expect(args.select.cosmetics.where).toEqual(where);
    expect(args.select.cosmetics.select.cosmetic).toEqual({
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        source: true,
        data: true,
        createdById: true,
        flags: true,
      },
    });
    expectNoKyselyRead();
  });

  it('ON: the Kysely reads on the replica, whose rows are the result', async () => {
    flag.mockResolvedValue(true);
    q.getUserIdIfExists.mockResolvedValue({ id: VIEWER } as never);
    q.listUserCosmeticsWithCosmetic.mockResolvedValue([
      {
        obtainedAt: new Date(0),
        equippedAt: null,
        equippedToId: null,
        equippedToType: null,
        forId: null,
        forType: null,
        claimKey: 'claimed',
        data: null,
        cosmeticId: COSMETIC,
        cosmeticName: 'on',
        cosmeticDescription: null,
        cosmeticType: 'Badge',
        cosmeticSource: 'Claim',
        cosmeticData: {},
        cosmeticCreatedById: null,
        cosmeticFlags: 0,
      },
    ] as never);
    await expect((await load())({ userId: VIEWER, equipped: true })).resolves.toEqual({
      cosmetics: [userCosmetic('on')],
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(q.getUserIdIfExists.mock.calls).toEqual([[kyselyRead, VIEWER]]);
    expect(q.listUserCosmeticsWithCosmetic.mock.calls).toEqual([
      [kyselyRead, { userId: VIEWER, equipped: true }],
    ]);
    expect(q.listUserCosmeticsWithCosmetic.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
  });

  it('ON, no such user: null, as Prisma', async () => {
    flag.mockResolvedValue(true);
    q.getUserIdIfExists.mockResolvedValue(undefined as never);
    q.listUserCosmeticsWithCosmetic.mockResolvedValue([] as never);
    await expect((await load())({ userId: VIEWER })).resolves.toBeNull();
  });
});

describe("modelVersionDonationGoal (a signed-in viewer's version read)", () => {
  const load = async () =>
    (await import('~/server/services/model-version.service')).modelVersionDonationGoal;
  const findArgs = {
    where: { id: VERSION },
    select: { id: true, modelId: true, model: { select: { userId: true } } },
  };

  it('OFF: one Prisma read on the replica, whose owner decides', async () => {
    dbMock.dbRead.modelVersion.findFirstOrThrow.mockResolvedValue({
      id: VERSION,
      modelId: MODEL,
      model: { userId: VIEWER },
    } as never);
    await (
      await load()
    )({ id: VERSION, userId: VIEWER });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.modelVersion.findFirstOrThrow.mock.calls).toEqual([[findArgs]]);
    // The viewer owns it, so their goals are read, not the public ones.
    expect(getOwnerDonationGoals.mock.calls).toEqual([['ModelVersion', [VERSION]]]);
    expect(getDonationGoals).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });

  it('ON: one Kysely read on the replica, whose owner decides', async () => {
    flag.mockResolvedValue(true);
    // The Prisma read would say someone else owns it, so only the Kysely row makes it the viewer's.
    dbMock.dbRead.modelVersion.findFirstOrThrow.mockResolvedValue({
      id: VERSION,
      modelId: MODEL,
      model: { userId: OWNER },
    } as never);
    q.getModelVersionWithOwner.mockResolvedValue({
      id: VERSION,
      modelId: MODEL,
      userId: VIEWER,
    } as never);
    await (
      await load()
    )({ id: VERSION, userId: VIEWER });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(q.getModelVersionWithOwner.mock.calls).toEqual([[kyselyRead, VERSION]]);
    expect(q.getModelVersionWithOwner.mock.calls[0][0]).toBe(kyselyRead);
    expect(getOwnerDonationGoals.mock.calls).toEqual([['ModelVersion', [VERSION]]]);
    expect(getDonationGoals).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it('ON, not on the replica: the same primary retry as OFF', async () => {
    flag.mockResolvedValue(true);
    q.getModelVersionWithOwner.mockResolvedValue(undefined as never);
    dbMock.dbWrite.modelVersion.findFirstOrThrow.mockResolvedValue({
      id: VERSION,
      modelId: MODEL,
      model: { userId: OWNER },
    } as never);
    await (
      await load()
    )({ id: VERSION, userId: VIEWER });
    expect(dbMock.dbWrite.modelVersion.findFirstOrThrow.mock.calls).toEqual([[findArgs]]);
    // The primary says someone else owns it: the public goals.
    expect(getDonationGoals.mock.calls).toEqual([['ModelVersion', [VERSION]]]);
    expect(getOwnerDonationGoals).not.toHaveBeenCalled();
  });

  it('an anonymous viewer reads no version and evaluates no flag', async () => {
    await (
      await load()
    )({ id: VERSION });
    expect(flag).not.toHaveBeenCalled();
    expect(dbMock.dbRead.modelVersion.findFirstOrThrow).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

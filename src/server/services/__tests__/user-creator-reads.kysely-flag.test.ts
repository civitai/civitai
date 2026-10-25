import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads from '@civitai/db-queries/hot-reads';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read query stubbed: their rows against Prisma's are compared in
// hot-reads-2.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});

import * as queries from '@civitai/db-queries/hot-reads';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { fetchUserCreator } from '~/server/services/user-creator.service';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);

// Pairwise distinct, and distinct from every count below.
const USER = 9101;
const PICTURE = 9202;
const COSMETIC = 9303;
const MODELS = 17;
const CREATED = new Date('2025-02-03T04:05:06.789Z');

const prismaUser = {
  id: USER,
  image: 'avatar.png',
  username: 'creator',
  muted: false,
  bannedAt: null,
  deletedAt: null,
  createdAt: CREATED,
  publicSettings: { a: 1 },
  settings: { creatorShop: { enabled: true } },
  excludeFromLeaderboards: true,
  links: [{ url: 'https://example.com', type: 'Social' }],
  stats: {
    downloadCountAllTime: 31,
    thumbsUpCountAllTime: 32,
    followerCountAllTime: 33,
    reactionCountAllTime: 34,
    uploadCountAllTime: 35,
    generationCountAllTime: 36,
  },
  rank: {
    leaderboardRank: 4,
    leaderboardId: 'lb',
    leaderboardTitle: 'Top',
    leaderboardCosmetic: null,
  },
  cosmetics: [
    {
      data: { lights: 2 },
      cosmetic: {
        id: COSMETIC,
        name: 'Badge',
        description: null,
        type: 'Badge',
        source: 'Event',
        data: { url: 'x' },
      },
    },
  ],
  profilePicture: {
    id: PICTURE,
    name: null,
    url: 'pic.png',
    nsfwLevel: 1,
    hash: 'h',
    userId: USER,
    ingestion: 'Scanned',
    type: 'image',
    width: 64,
    height: 48,
    metadata: { size: 1 },
  },
};

/** The same facts on both paths, so a difference in the answer is the port's. */
function givenBothPaths() {
  dbMock.dbRead.user.findFirst.mockResolvedValue(prismaUser);
  dbMock.dbRead.model.count.mockResolvedValue(MODELS);
  q.getUserCreatorRow.mockResolvedValue({
    id: USER,
    image: 'avatar.png',
    username: 'creator',
    muted: false,
    bannedAt: null,
    deletedAt: null,
    createdAt: CREATED,
    publicSettings: { a: 1 },
    settings: { creatorShop: { enabled: true } },
    excludeFromLeaderboards: true,
    links: [{ url: 'https://example.com', type: 'Social' }],
    rankUserId: USER,
    leaderboardRank: 4,
    leaderboardId: 'lb',
    leaderboardTitle: 'Top',
    leaderboardCosmetic: null,
    cosmetics: [
      {
        data: { lights: 2 },
        cosmeticId: COSMETIC,
        cosmeticName: 'Badge',
        cosmeticDescription: null,
        cosmeticType: 'Badge',
        cosmeticSource: 'Event',
        cosmeticData: { url: 'x' },
      },
    ],
    profilePictureId: PICTURE,
    profilePictureName: null,
    profilePictureUrl: 'pic.png',
    profilePictureNsfwLevel: 1,
    profilePictureHash: 'h',
    profilePictureUserId: USER,
    profilePictureIngestion: 'Scanned',
    profilePictureType: 'image',
    profilePictureWidth: 64,
    profilePictureHeight: 48,
    profilePictureMetadata: { size: 1 },
    modelCount: MODELS,
  } as never);
  q.getUserStatRow.mockResolvedValue({ ...prismaUser.stats } as never);
}

const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

// The ONE connection each client hands out (`db.connection().execute(cb)`), distinct per client.
const pinnedRead = { pinned: 'read' };
const pinnedWrite = { pinned: 'write' };
const readConnection = vi.spyOn(kyselyRead, 'connection');
const writeConnection = vi.spyOn(kyselyWrite, 'connection');
const pin = (conn: object) => ({ execute: (cb: (c: unknown) => unknown) => cb(conn) } as never);

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  readConnection.mockReset().mockImplementation(() => pin(pinnedRead));
  writeConnection.mockReset().mockImplementation(() => pin(pinnedWrite));
});

describe('fetchUserCreator (the creator card)', () => {
  it('control: the routing check below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });

  it('evaluates kysely-hot-reads-2 by key, with no entity or context', async () => {
    givenBothPaths();
    await fetchUserCreator({ id: USER });
    expect(flag.mock.calls).toEqual([['kysely-hot-reads-2']]);
  });

  it('OFF: reads the user and the model count through Prisma only', async () => {
    givenBothPaths();
    const card = await fetchUserCreator({ id: USER });
    expect(card).toMatchObject({ id: USER, creatorShopEnabled: true, _count: { models: MODELS } });
    expect(dbMock.dbRead.user.findFirst).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.model.count).toHaveBeenCalledWith({
      where: { userId: USER, status: 'Published' },
    });
    for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
  });

  it('ON: the same card through Kysely only, on the replica', async () => {
    givenBothPaths();
    const off = await fetchUserCreator({ id: USER });
    vi.clearAllMocks();
    flag.mockResolvedValue(true);

    await expect(fetchUserCreator({ id: USER })).resolves.toStrictEqual(off);
    expect(dbMock.dbRead.user.findFirst).not.toHaveBeenCalled();
    expect(dbMock.dbRead.model.count).not.toHaveBeenCalled();
    expect(q.getUserCreatorRow).toHaveBeenCalledTimes(1);
    // Both statements on the replica client's ONE connection; the stats by the resolved user id.
    expect(readConnection).toHaveBeenCalledTimes(1);
    expect(writeConnection).not.toHaveBeenCalled();
    expect(q.getUserCreatorRow.mock.calls[0][0]).toBe(pinnedRead);
    expect(q.getUserStatRow.mock.calls).toEqual([[pinnedRead, USER]]);
    expect(q.getUserCreatorRow.mock.calls[0][1]).toEqual({
      id: USER,
      username: undefined,
      systemUserId: -1,
      systemUsername: 'civitai',
    });
  });

  it('ON: a missing user is null, as on Prisma', async () => {
    flag.mockResolvedValue(true);
    q.getUserCreatorRow.mockResolvedValue(undefined);
    await expect(fetchUserCreator({ username: 'nobody' })).resolves.toBeNull();
    expect(q.getUserStatRow).not.toHaveBeenCalled();
  });
});

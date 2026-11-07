import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads10 from '@civitai/db-queries/hot-reads-10';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-10 statement stubbed: its row against Prisma's is compared in
// hot-reads-10.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-10', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads10>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// Which client the replication-lag check picks: set per test.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag: vi.fn(),
}));
// The cover visibility check is a raw query of its own, unchanged by the flag: every cover servable.
vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getServableCoverCollectionIds: vi.fn(
    async (candidates: { collectionId: number }[]) =>
      new Set(candidates.map((candidate) => candidate.collectionId))
  ),
}));

import * as queries from '@civitai/db-queries/hot-reads-10';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { collectionSelect } from '~/server/selectors/collection.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';

/**
 * `getCollectionById` behind `kysely-hot-reads-10`: the flag is evaluated by its key, with no
 * entity or context, once per call; OFF reads through Prisma on the client the replication-lag
 * check picked, exactly as before; ON reads through the one Kysely statement on the MATCHING Kysely
 * client (the replica for dbRead, the primary for dbWrite) and returns a value that can only have
 * come from the Kysely row (the ON fixture differs from the OFF one). Row parity against a real
 * database is in hot-reads-10.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const lag = vi.mocked(getDbWithoutLag);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));
const FLAG = 'kysely-hot-reads-10';

// Pairwise distinct.
const COLLECTION = 10801;
const OWNER = 10802;
const COVER = 10803;
const TAG = 10804;
const COSMETIC = 10805;

const load = async () => (await import('~/server/services/collection.service')).getCollectionById;

/** The Prisma-shaped collection, with no cover. */
const prismaCollection = (name: string) => ({
  id: COLLECTION,
  name,
  description: null,
  read: 'Public',
  write: 'Private',
  type: 'Image',
  nsfw: false,
  nsfwLevel: 1,
  image: null,
  mode: null,
  metadata: {},
  availability: 'Public',
  userId: OWNER,
  tags: [{ tag: { id: TAG, name: 'from prisma' }, filterableOnly: false }],
  user: {
    id: OWNER,
    username: 'owner',
    deletedAt: null,
    image: null,
    profilePicture: null,
    cosmetics: [],
  },
});

/** The Kysely row the same collection comes back as, with a cover, a tag and a cosmetic. */
const kyselyRow = {
  id: COLLECTION,
  name: 'from kysely',
  description: null,
  read: 'Public',
  write: 'Private',
  type: 'Image',
  nsfw: false,
  nsfwLevel: 1,
  mode: null,
  metadata: { from: 'kysely' },
  availability: 'Public',
  userId: OWNER,
  coverId: COVER,
  coverName: null,
  coverUrl: 'cover-url',
  coverNsfwLevel: 2,
  coverWidth: 640,
  coverHeight: 480,
  coverHash: null,
  coverMeta: null,
  coverUserId: OWNER,
  coverGenerationProcess: null,
  coverNeedsReview: null,
  coverScannedAt: null,
  coverIngestion: 'Scanned',
  coverBlockedFor: null,
  coverPostId: null,
  coverType: 'image',
  coverMetadata: {},
  coverCreatedAt: new Date(0),
  coverHideMeta: false,
  coverTags: [],
  tags: [{ tag: { id: TAG, name: 'from kysely' }, filterableOnly: true }],
  ownerId: OWNER,
  ownerUsername: 'owner',
  ownerDeletedAt: null,
  ownerImage: null,
  profilePictureId: null,
  cosmetics: [
    {
      data: null,
      cosmetic: { id: COSMETIC, data: {}, type: 'Badge', source: 'Claim', name: 'from kysely' },
    },
  ],
};

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  lag.mockReset().mockResolvedValue(dbMock.dbRead as never);
});

describe('control', () => {
  it('the routing checks below can tell the clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
    expect(dbMock.dbRead).not.toBe(dbMock.dbWrite);
  });
});

describe('getCollectionById', () => {
  it.each([
    ['the replica', 'dbRead', 'dbWrite'],
    ['the primary', 'dbWrite', 'dbRead'],
  ] as const)(
    'OFF, the lag check picks %s: the Prisma read there, with the select it always had',
    async (_, picked, other) => {
      lag.mockResolvedValue(dbMock[picked] as never);
      dbMock[picked].collection.findUnique.mockResolvedValue(
        prismaCollection('from prisma') as never
      );
      const collection = await (await load())({ input: { id: COLLECTION } });
      expect(collection.name).toBe('from prisma');
      expect(collection.tags).toEqual([{ id: TAG, name: 'from prisma', filterableOnly: false }]);
      expect(flag.mock.calls).toEqual([[FLAG]]);
      expect(lag.mock.calls).toEqual([['collection', COLLECTION]]);
      expect(dbMock[picked].collection.findUnique.mock.calls).toEqual([
        [
          {
            where: { id: COLLECTION },
            select: { ...collectionSelect, user: { select: userWithCosmeticsSelect } },
          },
        ],
      ]);
      expect(dbMock[other].collection.findUnique).not.toHaveBeenCalled();
      expectNoKyselyRead();
    }
  );

  it.each([
    ['the replica', 'dbRead', () => kyselyRead],
    ['the primary', 'dbWrite', () => kyselyWrite],
  ] as const)(
    'ON, the lag check picks %s: the one Kysely statement on the matching client',
    async (_, picked, client) => {
      flag.mockResolvedValue(true);
      lag.mockResolvedValue(dbMock[picked] as never);
      q.getCollectionByIdRow.mockResolvedValue(kyselyRow as never);
      const collection = await (await load())({ input: { id: COLLECTION } });
      expect(collection.name).toBe('from kysely');
      expect(collection.metadata).toEqual({ from: 'kysely' });
      expect(collection.tags).toEqual([{ id: TAG, name: 'from kysely', filterableOnly: true }]);
      expect(collection.image?.url).toBe('cover-url');
      expect(collection.user.cosmetics).toEqual([
        {
          data: null,
          cosmetic: { id: COSMETIC, data: {}, type: 'Badge', source: 'Claim', name: 'from kysely' },
        },
      ]);
      expect(flag.mock.calls).toEqual([[FLAG]]);
      expect(q.getCollectionByIdRow.mock.calls).toEqual([[client(), COLLECTION]]);
      expect(q.getCollectionByIdRow.mock.calls[0][0]).toBe(client());
      expect(dbMock.dbRead.collection.findUnique).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.collection.findUnique).not.toHaveBeenCalled();
    }
  );

  it('ON, no such collection: NOT_FOUND, as Prisma', async () => {
    flag.mockResolvedValue(true);
    q.getCollectionByIdRow.mockResolvedValue(undefined as never);
    await expect((await load())({ input: { id: COLLECTION } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('OFF, no such collection: NOT_FOUND (control)', async () => {
    dbMock.dbRead.collection.findUnique.mockResolvedValue(null as never);
    await expect((await load())({ input: { id: COLLECTION } })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expectNoKyselyRead();
  });
});

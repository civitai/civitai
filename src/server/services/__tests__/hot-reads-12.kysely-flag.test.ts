import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads12 from '@civitai/db-queries/hot-reads-12';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

// The Kysely/Prisma switch, read synchronously. FLIPT_FEATURE_FLAGS stays real, so the key asserted
// below is the one production evaluates. A client exists, so the gate never starts Flipt itself.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFliptSync: vi.fn(),
  getFliptClientSync: vi.fn(() => ({})),
  ensureFliptInitialized: vi.fn(async () => undefined),
}));
// Every hot-reads-12 statement stubbed: its rows against Prisma's are compared in
// hot-reads-12.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-12', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads12>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// Which client the replication-lag check picks: set per test.
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag: vi.fn(),
}));

import * as queries from '@civitai/db-queries/hot-reads-12';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { getDbWithoutLag } from '~/server/db/db-lag-helpers';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFliptSync } from '~/server/flipt/client';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  readResourceReviewsPage,
  readSimpleModelWithOwner,
  resetHotReads12GateForTests,
  type ResourceReviewsPageArgs,
} from '~/server/services/hot-reads-12.reads';

/**
 * `readSimpleModelWithOwner` (model.getSimple) and `readResourceReviewsPage`
 * (resourceReview.getInfinite) behind `kysely-hot-reads-12`: the flag is evaluated by its key, with
 * no entity or context; OFF reads through the original Prisma reads with the arguments they always
 * had; ON reads the users through the one Kysely statement (on the pool matching the client the
 * lag check picked, for model.getSimple) and returns values that can only have come from the
 * Kysely rows (the ON fixtures differ from the OFF ones). A missing key or a failing read is OFF.
 * Row parity against a real database is in hot-reads-12.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFliptSync);
const lag = vi.mocked(getDbWithoutLag);
const modelRow = vi.mocked(queries.getSimpleModelWithOwnerRow);
const usersRows = vi.mocked(queries.listUsersWithCosmeticsRows);
const FLAG = 'kysely-hot-reads-12';

// Pairwise distinct.
const MODEL = 14101;
const OWNER = 14201;
const REVIEWER = 14202;
const PICTURE = 14301;
const COSMETIC = 14401;
const REVIEW = 14501;
const REVIEW_2 = 14502;
const VERSION = 14601;
const CREATED_AT = new Date('2026-11-01T01:02:03.004Z');

/** A Kysely users row: a Scanned picture and one cosmetic. */
const kyselyUserRow = (id: number, username: string) => ({
  id,
  username,
  deletedAt: null,
  image: null,
  profilePictureId: PICTURE,
  profilePictureName: null,
  profilePictureUrl: 'from-kysely',
  profilePictureNsfwLevel: 1,
  profilePictureHash: null,
  profilePictureUserId: id,
  profilePictureIngestion: 'Scanned',
  profilePictureNeedsReview: null,
  profilePictureType: 'image',
  profilePictureWidth: 10,
  profilePictureHeight: 20,
  profilePictureMetadata: {},
  cosmetics: [
    {
      data: null,
      cosmetic: { id: COSMETIC, data: {}, type: 'Badge', source: 'Claim', name: 'kysely badge' },
    },
  ],
});

/** What `kyselyUserRow` maps to: `userWithCosmeticsSelect`'s payload. */
const kyselyUser = (id: number, username: string) => ({
  id,
  username,
  deletedAt: null,
  image: null,
  profilePicture: {
    id: PICTURE,
    name: null,
    url: 'from-kysely',
    nsfwLevel: 1,
    hash: null,
    userId: id,
    ingestion: 'Scanned',
    type: 'image',
    width: 10,
    height: 20,
    metadata: {},
  },
  cosmetics: [
    {
      data: null,
      cosmetic: { id: COSMETIC, data: {}, type: 'Badge', source: 'Claim', name: 'kysely badge' },
    },
  ],
});

const prismaUser = (id: number) => ({
  id,
  username: 'from prisma',
  deletedAt: null,
  image: null,
  profilePicture: null,
  cosmetics: [],
});

beforeEach(() => {
  resetSharedMocks();
  resetHotReads12GateForTests();
  modelRow.mockReset();
  usersRows.mockReset();
  flag.mockReset().mockReturnValue(false);
  lag.mockReset().mockResolvedValue(dbMock.dbRead as never);
});

describe('control', () => {
  it('the routing checks below can tell the clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
    expect(dbMock.dbRead).not.toBe(dbMock.dbWrite);
  });
});

describe('readSimpleModelWithOwner (model.getSimple)', () => {
  const PRISMA_ARGS = {
    where: { id: MODEL },
    select: {
      id: true,
      name: true,
      createdAt: true,
      locked: true,
      status: true,
      user: { select: userWithCosmeticsSelect },
    },
  };
  const prismaModel = { id: MODEL, name: 'from prisma', user: prismaUser(OWNER) };

  it.each<[string, 'dbRead' | 'dbWrite']>([
    ['the replica', 'dbRead'],
    ['the primary', 'dbWrite'],
  ])('OFF: the original Prisma read on %s, with its original arguments', async (_, picked) => {
    lag.mockResolvedValue(dbMock[picked] as never);
    dbMock[picked].model.findFirst.mockResolvedValue(prismaModel as never);
    await expect(readSimpleModelWithOwner(MODEL)).resolves.toEqual(prismaModel);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(lag.mock.calls).toEqual([['model', MODEL]]);
    expect(dbMock[picked].model.findFirst.mock.calls).toEqual([[PRISMA_ARGS]]);
    expect(modelRow).not.toHaveBeenCalled();
  });

  it.each<[string, 'dbRead' | 'dbWrite', () => unknown]>([
    ['the replica', 'dbRead', () => kyselyRead],
    ['the primary', 'dbWrite', () => kyselyWrite],
  ])(
    'ON: one Kysely statement on the pool matching %s, whose row is the result',
    async (_, picked, pool) => {
      flag.mockReturnValue(true);
      lag.mockResolvedValue(dbMock[picked] as never);
      modelRow.mockResolvedValue({
        ...kyselyUserRow(OWNER, 'kysely owner'),
        modelId: MODEL,
        modelName: 'from kysely',
        modelCreatedAt: CREATED_AT,
        modelLocked: true,
        modelStatus: 'Published',
      } as never);
      await expect(readSimpleModelWithOwner(MODEL)).resolves.toStrictEqual({
        id: MODEL,
        name: 'from kysely',
        createdAt: CREATED_AT,
        locked: true,
        status: 'Published',
        user: kyselyUser(OWNER, 'kysely owner'),
      });
      expect(flag.mock.calls).toEqual([[FLAG]]);
      expect(modelRow.mock.calls).toEqual([[pool(), MODEL]]);
      expect(modelRow.mock.calls[0][0]).toBe(pool());
      expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.model.findFirst).not.toHaveBeenCalled();
    }
  );

  it('ON with no Kysely row: the Prisma read answers (a missing model, or an orphan)', async () => {
    flag.mockReturnValue(true);
    modelRow.mockResolvedValue(undefined as never);
    dbMock.dbRead.model.findFirst.mockResolvedValue(null as never);
    await expect(readSimpleModelWithOwner(MODEL)).resolves.toBeNull();
    expect(modelRow).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.model.findFirst.mock.calls).toEqual([[PRISMA_ARGS]]);
  });

  it.each<[string, () => void]>([
    ['a missing key (null)', () => flag.mockReturnValue(null)],
    [
      'a throwing read',
      () =>
        flag.mockImplementation(() => {
          throw new Error('flipt down');
        }),
    ],
  ])('%s reads as OFF', async (_, arrange) => {
    arrange();
    dbMock.dbRead.model.findFirst.mockResolvedValue(prismaModel as never);
    await readSimpleModelWithOwner(MODEL);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.model.findFirst).toHaveBeenCalledTimes(1);
    expect(modelRow).not.toHaveBeenCalled();
  });
});

describe('readResourceReviewsPage (resourceReview.getInfinite)', () => {
  const ARGS: ResourceReviewsPageArgs = {
    take: 11,
    cursor: { id: 14999 },
    where: { AND: [{ modelId: MODEL }] },
    orderBy: [{ createdAt: 'desc' }],
    includeModel: false,
  };
  const COLUMNS = {
    id: true,
    modelId: true,
    modelVersionId: true,
    details: true,
    createdAt: true,
    rating: true,
    recommended: true,
  };
  const FIND_ARGS = { take: 11, cursor: { id: 14999 }, where: ARGS.where, orderBy: ARGS.orderBy };
  const review = (id: number) => ({
    id,
    modelId: MODEL,
    modelVersionId: VERSION,
    details: `review ${id}`,
    createdAt: CREATED_AT,
    rating: 5,
    recommended: true,
  });

  it.each<[string, boolean]>([
    ['without', false],
    ['with', true],
  ])('OFF: the original nested Prisma read on the replica, %s models', async (_, includeModel) => {
    const page = [{ ...review(REVIEW), user: prismaUser(REVIEWER) }];
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue(page as never);
    await expect(readResourceReviewsPage({ ...ARGS, includeModel })).resolves.toEqual(page);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    const related = includeModel ? { select: { id: true, name: true } } : undefined;
    expect(dbMock.dbRead.resourceReview.findMany.mock.calls).toEqual([
      [
        {
          ...FIND_ARGS,
          select: {
            ...COLUMNS,
            user: { select: userWithCosmeticsSelect },
            model: related,
            modelVersion: related,
          },
        },
      ],
    ]);
    expect(usersRows).not.toHaveBeenCalled();
  });

  it('ON: the reviews through Prisma with userId, their users from ONE Kysely statement on the replica', async () => {
    flag.mockReturnValue(true);
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([
      { ...review(REVIEW), userId: REVIEWER },
      { ...review(REVIEW_2), userId: OWNER },
      { ...review(14503), userId: REVIEWER },
    ] as never);
    usersRows.mockResolvedValue([
      kyselyUserRow(REVIEWER, 'kysely reviewer'),
      kyselyUserRow(OWNER, 'kysely owner'),
    ] as never);
    const page = await readResourceReviewsPage(ARGS);
    expect(page).toStrictEqual([
      { ...review(REVIEW), user: kyselyUser(REVIEWER, 'kysely reviewer') },
      { ...review(REVIEW_2), user: kyselyUser(OWNER, 'kysely owner') },
      { ...review(14503), user: kyselyUser(REVIEWER, 'kysely reviewer') },
    ]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.resourceReview.findMany.mock.calls).toEqual([
      [
        {
          ...FIND_ARGS,
          select: { ...COLUMNS, userId: true, model: undefined, modelVersion: undefined },
        },
      ],
    ]);
    // Each user once.
    expect(usersRows.mock.calls).toEqual([[kyselyRead, [REVIEWER, OWNER]]]);
    expect(usersRows.mock.calls[0][0]).toBe(kyselyRead);
  });

  it('ON with models: they are kept, in the Prisma key order', async () => {
    flag.mockReturnValue(true);
    const model = { id: MODEL, name: 'm' };
    const modelVersion = { id: VERSION, name: 'v' };
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([
      { ...review(REVIEW), userId: REVIEWER, model, modelVersion },
    ] as never);
    usersRows.mockResolvedValue([kyselyUserRow(REVIEWER, 'kysely reviewer')] as never);
    const [first] = await readResourceReviewsPage({ ...ARGS, includeModel: true });
    expect(first).toStrictEqual({
      ...review(REVIEW),
      user: kyselyUser(REVIEWER, 'kysely reviewer'),
      model,
      modelVersion,
    });
    expect(Object.keys(first)).toStrictEqual([
      ...Object.keys(COLUMNS),
      'user',
      'model',
      'modelVersion',
    ]);
  });

  it('ON with an empty page: no Kysely statement', async () => {
    flag.mockReturnValue(true);
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
    await expect(readResourceReviewsPage(ARGS)).resolves.toStrictEqual([]);
    expect(usersRows).not.toHaveBeenCalled();
  });

  it('ON with a review whose user is gone: throws, as the required Prisma relation does', async () => {
    flag.mockReturnValue(true);
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([
      { ...review(REVIEW), userId: REVIEWER },
    ] as never);
    usersRows.mockResolvedValue([] as never);
    await expect(readResourceReviewsPage(ARGS)).rejects.toThrow(/has no user/);
  });

  it('the flag is read once per refresh window, not once per call', async () => {
    flag.mockReturnValue(true);
    dbMock.dbRead.resourceReview.findMany.mockResolvedValue([] as never);
    await readResourceReviewsPage(ARGS);
    await readResourceReviewsPage(ARGS);
    expect(flag).toHaveBeenCalledTimes(1);
    expect(dbMock.dbRead.resourceReview.findMany).toHaveBeenCalledTimes(2);
  });
});

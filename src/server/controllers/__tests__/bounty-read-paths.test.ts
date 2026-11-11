import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BountyVisibility from '~/server/services/bounty-visibility';
import type * as BountyEntryService from '~/server/services/bountyEntry.service';
import type * as BountyBenefactorService from '~/server/services/bountyBenefactor.service';
import type * as UserPreferences from '~/server/services/user-preferences.service';
import type * as BountyService from '~/server/services/bounty.service';
import type * as FileService from '~/server/services/file.service';
import type * as ImageService from '~/server/services/image.service';
import type * as UserService from '~/server/services/user.service';
import { TRPCError } from '@trpc/server';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const {
  mockAssert,
  mockGetEntries,
  mockGetBenefactors,
  mockGetEntryById,
  mockGetEntryFiles,
  mockUpsertBounty,
  mockDeleteBounty,
  mockBountyImages,
  mockImagesForBounties,
  mockImagesByEntity,
} = vi.hoisted(() => ({
  mockAssert: vi.fn(),
  mockGetEntries: vi.fn(async () => []),
  mockGetBenefactors: vi.fn(async () => []),
  mockGetEntryById: vi.fn(async () => ({ id: 3, user: { id: 5 } })),
  mockGetEntryFiles: vi.fn(async () => []),
  mockUpsertBounty: vi.fn(),
  mockDeleteBounty: vi.fn(),
  mockBountyImages: vi.fn(async (): Promise<unknown[]> => []),
  mockImagesForBounties: vi.fn(async (): Promise<Record<number, unknown[]>> => ({})),
  mockImagesByEntity: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesByEntity: mockImagesByEntity,
}));

// The showcase hat is a cache read beside these checks; it has its own test.
vi.mock('~/server/events/showcase-hat', () => ({ getShowcaseHatForUser: async () => null }));
vi.mock('~/server/services/bounty-visibility', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyVisibility>()),
  assertBountyVisible: mockAssert,
}));
vi.mock('~/server/services/bountyEntry.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyEntryService>()),
  getAllEntriesByBountyId: mockGetEntries,
  getEntryById: mockGetEntryById,
  getBountyEntryFilteredFiles: mockGetEntryFiles,
  getBountyEntryEarnedBuzz: vi.fn(async () => []),
}));
vi.mock('~/server/services/bounty.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyService>()),
  upsertBounty: mockUpsertBounty,
  deleteBountyById: mockDeleteBounty,
  getBountyImages: mockBountyImages,
  getImagesForBounties: mockImagesForBounties,
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFilesByEntity: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/bountyBenefactor.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BountyBenefactorService>()),
  getAllBenefactorsByBountyId: mockGetBenefactors,
}));
const emptyPreference = { getCached: vi.fn(async () => [] as { id: number }[]) };
vi.mock('~/server/services/user-preferences.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserPreferences>()),
  HiddenUsers: emptyPreference,
  BlockedUsers: emptyPreference,
  BlockedByUsers: emptyPreference,
}));

// event-engine-common is a git submodule a fresh checkout does not have; image.service imports it.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; the controllers' import graph reads env at load.
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

const {
  getBountyHandler,
  getInfiniteBountiesHandler,
  getBountyEntriesHandler,
  getBountyBenefactorsHandler,
  addBenefactorUnitAmountHandler,
  upsertBountyHandler,
  deleteBountyHandler,
} = await import('../bounty.controller');
const {
  getBountyEntryHandler,
  getBountyEntryFilteredFilesHandler,
  upsertBountyEntryHandler,
  submitBountyEntryHandler,
} = await import('../bountyEntry.controller');
// canViewNsfw: true, so the domain applies no browsing-level cap.
const uncapped = { features: { canViewNsfw: true } };
const stranger = { user: { id: 6 }, ...uncapped } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockAssert.mockRejectedValue(new TRPCError({ code: 'NOT_FOUND' }));
});

describe('a Private bounty is not reachable through its satellite reads', () => {
  it.each([
    [
      'getEntries',
      () => getBountyEntriesHandler({ input: { id: 9 } as never, ctx: stranger }),
      mockGetEntries,
      { bountyId: 9 },
    ],
    [
      'getBenefactors',
      () => getBountyBenefactorsHandler({ input: { id: 9 }, ctx: stranger }),
      mockGetBenefactors,
      { bountyId: 9 },
    ],
    [
      'entry detail',
      () => getBountyEntryHandler({ input: { id: 3 }, ctx: stranger }),
      mockGetEntryById,
      { entryId: 3 },
    ],
    [
      'entry files',
      () => getBountyEntryFilteredFilesHandler({ input: { id: 3 }, ctx: stranger }),
      mockGetEntryFiles,
      { entryId: 3 },
    ],
  ])('%s 404s before reading anything', async (_label, call, downstream, target) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockAssert).toHaveBeenCalledWith(target, { id: 6 });
    expect(downstream).not.toHaveBeenCalled();
  });

  // A participant who is not the owner cannot keep adding entries or Buzz to a hidden bounty.
  it.each([
    [
      'bountyEntry.upsert',
      () => upsertBountyEntryHandler({ input: { bountyId: 9 } as never, ctx: stranger }),
    ],
    [
      'bountyEntry.submit',
      () =>
        submitBountyEntryHandler({
          input: { bountyId: 9, files: [], imageUuids: [] } as never,
          ctx: stranger,
        }),
    ],
    [
      'bounty.addBenefactorUnitAmount',
      () =>
        addBenefactorUnitAmountHandler({
          input: { bountyId: 9, unitAmount: 100 } as never,
          ctx: stranger,
        }),
    ],
  ])('%s on a hidden bounty 404s', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockAssert).toHaveBeenCalledWith({ bountyId: 9 }, { id: 6 });
    expect(dbMock.dbRead.bounty.findUnique).not.toHaveBeenCalled();
  });
});

describe('bounty write responses', () => {
  const row = {
    id: 9,
    name: 'B',
    meta: { textScanFlags: { poi: { reason: 'r', names: ['Jane Doe'] } } },
  };
  const ctx = {
    user: { id: 5 },
    ...uncapped,
    track: { bounty: vi.fn(async () => undefined) },
  } as never;

  it('upsert never returns meta', async () => {
    mockUpsertBounty.mockResolvedValue(row);
    const result = await upsertBountyHandler({ input: { id: 9 } as never, ctx });
    expect(result).toEqual({ id: 9, name: 'B' });
  });

  it('upsert returns the profanity details to a moderator only', async () => {
    const details = {
      baseModel: 'SD 1.5',
      profanityMatches: ['term'],
      profanityEvaluation: { reason: 'test reason' },
    };
    mockUpsertBounty.mockResolvedValue({ ...row, details });
    const asUser = await upsertBountyHandler({ input: { id: 9 } as never, ctx });
    expect(asUser).toEqual({ id: 9, name: 'B', details: { baseModel: 'SD 1.5' } });
    const modCtx = { ...(ctx as object), user: { id: 5, isModerator: true } } as never;
    const asMod = await upsertBountyHandler({ input: { id: 9 } as never, ctx: modCtx });
    expect(asMod).toEqual({ id: 9, name: 'B', details });
  });

  it('delete never returns meta', async () => {
    mockDeleteBounty.mockResolvedValue(row);
    const result = await deleteBountyHandler({ input: { id: 9 }, ctx });
    expect(result).toEqual({ id: 9, name: 'B' });
  });
});

describe('bounty detail and feed visibility', () => {
  const OWNER = 5;
  const privateBounty = {
    id: 9,
    name: 'B',
    availability: 'Private',
    poi: false,
    user: { id: OWNER },
    details: null,
    tags: [],
    meta: { textScanFlags: { poi: { reason: 'r', names: ['Jane Doe'] } } },
  };

  beforeEach(() => dbMock.dbRead.bounty.findUnique.mockResolvedValue(privateBounty));

  it('getBounty is not found for a stranger', async () => {
    await expect(getBountyHandler({ input: { id: 9 }, ctx: stranger })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it.each([
    ['the owner', { id: OWNER }],
    ['a moderator', { id: 77, isModerator: true }],
  ])('getBounty returns it to %s, without meta', async (_label, user) => {
    const result = await getBountyHandler({
      input: { id: 9 },
      ctx: { user, ...uncapped } as never,
    });
    expect(result.id).toBe(9);
    expect(result).not.toHaveProperty('meta');
  });

  it("getInfinite filters by the viewer's own id, not the profile being browsed", async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([]);
    await getInfiniteBountiesHandler({
      input: { limit: 10, userId: 99, period: 'AllTime', sort: 'Newest' } as never,
      ctx: stranger,
    });
    expect(dbMock.dbRead.bounty.findMany).toHaveBeenCalledTimes(1);
    const { where } = dbMock.dbRead.bounty.findMany.mock.calls[0][0];
    expect(where.AND).toContainEqual({
      OR: [{ availability: { not: 'Private' } }, { userId: 6 }],
    });
  });
});

describe('bounty images on a capped site', () => {
  const OWNER = 5;
  const signedInSfw = { user: { id: 6 }, features: { canViewNsfw: false } };
  const signedOut = { features: { canViewNsfw: false } };
  const image = (id: number, nsfwLevel: number, entityId = 0) => ({
    id,
    entityId,
    nsfwLevel,
    nsfwLefel: nsfwLevel,
    tags: [],
  });
  const feedBounty = (id: number, nsfw = false) => ({
    id,
    name: 'B',
    nsfw,
    nsfwLevel: 3,
    tags: [],
    user: { id: OWNER },
  });
  const detailBounty = {
    id: 9,
    name: 'B',
    availability: 'Public',
    poi: false,
    user: { id: OWNER },
    details: null,
    tags: [],
    meta: {},
  };
  const feedInput = { limit: 10, period: 'AllTime', sort: 'Newest' } as never;
  const ids = (images: { id: number }[]) => images.map((i) => i.id);
  const detail = async (ctx: object) => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue(detailBounty);
    mockBountyImages.mockResolvedValue([image(10, NsfwLevel.PG13), image(11, NsfwLevel.R)]);
    return ids((await getBountyHandler({ input: { id: 9 }, ctx: ctx as never })).images);
  };

  beforeEach(() => mockAssert.mockResolvedValue(undefined));

  it('the feed sends a capped viewer no image above the cap, and drops a bounty left with none', async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([feedBounty(1), feedBounty(2)]);
    mockImagesForBounties.mockResolvedValue({
      1: [
        image(10, NsfwLevel.PG),
        image(11, NsfwLevel.X),
        image(12, 0),
        image(13, NsfwLevel.PG | NsfwLevel.XXX),
      ],
      2: [image(20, NsfwLevel.R)],
    });
    const { items } = await getInfiniteBountiesHandler({
      input: feedInput,
      ctx: signedOut as never,
    });
    expect(items.map((b) => b.id)).toEqual([1]);
    expect(ids(items[0].images)).toEqual([10]);
  });

  it('the feed caps a bounty marked NSFW by its marking, not its scanned images', async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([feedBounty(1, true)]);
    mockImagesForBounties.mockResolvedValue({ 1: [image(10, NsfwLevel.PG)] });
    const { items } = await getInfiniteBountiesHandler({
      input: feedInput,
      ctx: signedInSfw as never,
    });
    expect(items).toEqual([]);
  });

  it('the feed caps by the level the service reports, not a stale one on the row', async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([feedBounty(1)]);
    mockImagesForBounties.mockResolvedValue({
      1: [image(10, NsfwLevel.PG), { ...image(11, NsfwLevel.PG), nsfwLefel: NsfwLevel.X }],
    });
    const { items } = await getInfiniteBountiesHandler({
      input: feedInput,
      ctx: signedOut as never,
    });
    expect(ids(items[0].images)).toEqual([10]);
  });

  it('the detail page sends a capped viewer no image above the cap', async () => {
    expect(await detail(signedInSfw)).toEqual([10]);
  });

  it('the detail page sends a bounty with no image inside the cap no image', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue(detailBounty);
    mockBountyImages.mockResolvedValue([image(11, NsfwLevel.X)]);
    const result = await getBountyHandler({ input: { id: 9 }, ctx: signedOut as never });
    expect(result.images).toEqual([]);
  });

  // The edit form is filled from this read and saves back only the images it was shown.
  it.each([
    ['the owner', { user: { id: OWNER }, features: { canViewNsfw: false } }],
    ['a moderator', { user: { id: 77, isModerator: true }, features: { canViewNsfw: false } }],
  ])(
    'the detail page keeps every image for %s, whose edit saves back what it is shown',
    async (_l, ctx) => {
      expect(await detail(ctx)).toEqual([10, 11]);
    }
  );

  it('entry lists and entry detail send a capped viewer no image above the cap', async () => {
    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: OWNER } }] as never);
    mockImagesByEntity.mockResolvedValue([image(30, NsfwLevel.PG, 3), image(31, NsfwLevel.X, 3)]);
    const list = await getBountyEntriesHandler({
      input: { id: 9 } as never,
      ctx: signedInSfw as never,
    });
    expect(ids(list.items[0].images)).toEqual([30]);

    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: signedInSfw as never });
    expect(ids(entry.images)).toEqual([30]);
  });

  it('entry detail keeps every image for the entry owner, whose edit saves back what it is shown', async () => {
    mockImagesByEntity.mockResolvedValue([image(30, NsfwLevel.PG, 3), image(31, NsfwLevel.X, 3)]);
    const ctx = { user: { id: OWNER }, features: { canViewNsfw: false } };
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: ctx as never });
    expect(ids(entry.images)).toEqual([30, 31]);
  });

  it('an uncapped viewer keeps every image', async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([feedBounty(1)]);
    mockImagesForBounties.mockResolvedValue({
      1: [image(10, NsfwLevel.PG), image(11, NsfwLevel.X)],
    });
    const { items } = await getInfiniteBountiesHandler({ input: feedInput, ctx: stranger });
    expect(ids(items[0].images)).toEqual([10, 11]);
    expect(await detail(stranger as object)).toEqual([10, 11]);

    mockImagesByEntity.mockResolvedValue([image(30, NsfwLevel.PG, 3), image(31, NsfwLevel.X, 3)]);
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: stranger });
    expect(ids(entry.images)).toEqual([30, 31]);
  });
});

describe('entry detail image count', () => {
  const OWNER = 5;
  const twelve = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, entityId: 3, nsfwLevel: 1 }));
  const entryImageCount = async (ctx: object) => {
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: ctx as never });
    return entry.images.length;
  };

  beforeEach(() => {
    mockAssert.mockResolvedValue(undefined);
    mockImagesByEntity.mockImplementation((async ({ imagesPerId = 4 }: { imagesPerId?: number }) =>
      twelve.slice(0, imagesPerId)) as never);
  });

  it.each([
    ['owner', { user: { id: OWNER }, ...uncapped }],
    ['moderator', { user: { id: 7, isModerator: true }, ...uncapped }],
  ])('gives the %s every image so an edit keeps them', async (_who, ctx) => {
    expect(await entryImageCount(ctx)).toBe(12);
  });

  it('still gives other viewers 10', async () => {
    expect(await entryImageCount(stranger as object)).toBe(10);
  });
});

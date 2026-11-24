import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { imageTagsCache } from '~/server/redis/caches';
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
import { childBrowsingTagIds } from '@civitai/shared';
import { filterPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { NsfwLevel } from '~/server/common/enums';
import { bountyNsfwFlagLevel } from '~/server/services/bounty-rated-level';
import { upsertBountyEntryInputSchema } from '~/server/schema/bounty-entry.schema';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const {
  mockAssert,
  mockGetEntries,
  mockGetBenefactors,
  mockGetEntryById,
  mockGetEntryFiles,
  mockUpsertBounty,
  mockUpsertEntry,
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
  mockUpsertEntry: vi.fn(async (_input: Record<string, unknown>) => ({ id: 3 })),
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
  upsertBountyEntry: mockUpsertEntry,
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

vi.mock('~/server/services/system-cache', async (importOriginal) => {
  const { DEFAULT_BROWSING_SETTINGS_ADDONS } = await import(
    '~/shared/constants/browsing-settings-addons'
  );
  return {
    ...(await importOriginal<object>()),
    getBlockedBrowsingTags: vi.fn(async () => []),
    getBrowsingSettingAddons: vi.fn(async () => DEFAULT_BROWSING_SETTINGS_ADDONS),
  };
});

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

  // The headless submit never reads the entry's images, so its edit replaces the set; the web
  // form's edit removes only what it was shown.
  it.each([
    ['submit', true],
    ['upsert', undefined],
  ])('an entry edit through %s replaces its images: %s', async (path, replaceImages) => {
    const editor = {
      user: { id: 5 },
      ...uncapped,
      track: { bountyEntry: vi.fn(async () => undefined) },
    } as never;
    mockAssert.mockResolvedValue(undefined);
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      userId: 99,
      complete: false,
      entries: [],
    } as never);
    const file = { url: 'https://example.com/f.zip', name: 'f.zip', sizeKB: 1 };
    if (path === 'submit')
      await submitBountyEntryHandler({
        input: { id: 3, bountyId: 9, files: [file], imageUuids: ['u'] } as never,
        ctx: editor,
      });
    else await upsertBountyEntryHandler({ input: { id: 3, bountyId: 9 } as never, ctx: editor });
    expect(mockUpsertEntry.mock.calls[0][0]).toMatchObject({ replaceImages });
  });

  // Replace is decided by the route; a client that sends it to upsert gets the shown-ids rule.
  it('the upsert route ignores a replaceImages sent by the client', async () => {
    const sent = {
      id: 3,
      bountyId: 9,
      files: [{ url: 'https://example.com/f.zip', name: 'f.zip', sizeKB: 1, metadata: {} }],
      images: [],
      replaceImages: true,
    };
    expect(upsertBountyEntryInputSchema.parse(sent)).not.toHaveProperty('replaceImages');

    mockAssert.mockResolvedValue(undefined);
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      userId: 99,
      complete: false,
      entries: [],
    } as never);
    const editor = {
      user: { id: 5 },
      ...uncapped,
      track: { bountyEntry: vi.fn(async () => undefined) },
    } as never;
    await upsertBountyEntryHandler({ input: sent as never, ctx: editor });
    expect(mockUpsertEntry.mock.calls[0][0].replaceImages).toBeUndefined();
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

  it("sends the text scan's record to a moderator only, from getBounty and upsert", async () => {
    const details = { baseModel: 'SD 1.5', textScanNsfw: { workflowId: 'w', level: 4 } };
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      ...privateBounty,
      availability: 'Public',
      details,
    });
    mockAssert.mockResolvedValue(undefined);
    mockUpsertBounty.mockResolvedValue({ id: 9, name: 'B', details });
    const track = { bounty: vi.fn(async () => undefined) };
    for (const [user, expected] of [
      [{ id: OWNER }, { baseModel: 'SD 1.5' }],
      [{ id: 77, isModerator: true }, details],
    ] as const) {
      const ctx = { user, ...uncapped, track } as never;
      expect((await getBountyHandler({ input: { id: 9 }, ctx })).details).toEqual(expected);
      expect((await upsertBountyHandler({ input: { id: 9 } as never, ctx })).details).toEqual(
        expected
      );
    }
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

  // Unrated and mixed ratings reaching above the cap are dropped; a mixed rating inside it is kept.
  const mixedImages = (entityId = 0) => [
    image(40, 0, entityId),
    image(41, NsfwLevel.PG | NsfwLevel.XXX, entityId),
    image(42, NsfwLevel.PG | NsfwLevel.PG13, entityId),
  ];

  it('the detail page drops unrated and mixed-above-cap images and keeps an in-cap mix', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue(detailBounty);
    mockBountyImages.mockResolvedValue(mixedImages());
    const result = await getBountyHandler({ input: { id: 9 }, ctx: signedInSfw as never });
    expect(ids(result.images)).toEqual([42]);
  });

  it('entry lists and entry detail drop unrated and mixed-above-cap images and keep an in-cap mix', async () => {
    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: OWNER } }] as never);
    mockImagesByEntity.mockResolvedValue(mixedImages(3));
    const list = await getBountyEntriesHandler({
      input: { id: 9 } as never,
      ctx: signedInSfw as never,
    });
    expect(ids(list.items[0].images)).toEqual([42]);

    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: signedInSfw as never });
    expect(ids(entry.images)).toEqual([42]);
  });

  it.each([
    ['the owner', { user: { id: OWNER }, features: { canViewNsfw: false } }],
    ['a moderator', { user: { id: 77, isModerator: true }, features: { canViewNsfw: false } }],
  ])('the detail page caps %s like any other viewer', async (_l, ctx) => {
    expect(await detail(ctx)).toEqual([10]);
  });

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

  it('entry detail caps the entry owner like any other viewer', async () => {
    mockImagesByEntity.mockResolvedValue([image(30, NsfwLevel.PG, 3), image(31, NsfwLevel.X, 3)]);
    const ctx = { user: { id: OWNER }, features: { canViewNsfw: false } };
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: ctx as never });
    expect(ids(entry.images)).toEqual([30]);
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

describe('an nsfw-flagged bounty in the feed', () => {
  // A queued answer a test does not consume would otherwise reach the next one.
  beforeEach(() => dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]));
  const feedInput = { limit: 10, period: 'AllTime', sort: 'Newest' } as never;
  const flagged = (moderatorNsfwLevel: number | null = null) => ({
    id: 1,
    name: 'B',
    nsfw: true,
    nsfwLevel: 60,
    moderatorNsfwLevel,
    tags: [],
    user: { id: 5 },
  });
  const scanRow = (scanLevel: number | null, byScan = true, content: number = NsfwLevel.PG) => [
    { id: 1, byScan, scanCurrent: true, scanLevel, scanVersion: '1', content },
  ];
  const feed = async (bounty: object, rows: object[]) => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([bounty]);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(rows);
    mockImagesForBounties.mockResolvedValue({
      1: [{ id: 10, userId: 5, nsfwLevel: NsfwLevel.PG, nsfwLefel: NsfwLevel.PG, tags: [] }],
    });
    return (await getInfiniteBountiesHandler({ input: feedInput, ctx: stranger })).items;
  };
  const visibleAt = (items: unknown[], browsingLevel: number) =>
    filterPreferences({
      type: 'bounties',
      data: items as never,
      hiddenPreferences: {
        hiddenUsers: new Map(),
        blockRelations: new Map(),
        hiddenTags: new Map(),
        hiddenModels: new Map(),
        hiddenModel3Ds: new Map(),
        hiddenImages: new Map(),
        hiddenLoading: false,
        moderatedTags: [],
        systemHiddenTags: new Map(),
        moderatedHiddenImages: new Map(),
      },
      browsingLevel,
      currentUser: { id: 6 } as never,
      canViewNsfw: true,
    }).items.length > 0;

  it('lists a bounty its text rated R to an R browser, and hides it at PG-13', async () => {
    const items = await feed(flagged(), scanRow(NsfwLevel.R));
    expect(items[0]).toMatchObject({
      nsfwLevel: NsfwLevel.R,
      images: [{ nsfwLevel: NsfwLevel.R }],
    });
    expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R)).toBe(true);
    expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13)).toBe(false);
  });

  it('rates a text-rated bounty up to its images when they rate higher', async () => {
    const items = await feed(flagged(), scanRow(NsfwLevel.R, true, NsfwLevel.X));
    expect(items[0]).toMatchObject({ nsfwLevel: NsfwLevel.X });
    expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R)).toBe(false);
    expect(visibleAt(items, NsfwLevel.X)).toBe(true);
  });

  it('keeps a flag with no recorded rating XXX-only', async () => {
    const notRated = [
      [],
      scanRow(NsfwLevel.R, false),
      scanRow(NsfwLevel.PG13),
      scanRow(NsfwLevel.Blocked),
      [{ ...scanRow(NsfwLevel.R)[0], scanVersion: null }],
      [{ ...scanRow(NsfwLevel.R)[0], scanLevel: null }],
      [{ ...scanRow(NsfwLevel.R)[0], scanCurrent: false }],
    ];
    for (const rows of notRated) {
      const items = await feed(flagged(), rows);
      expect(items[0]).toMatchObject({
        nsfwLevel: NsfwLevel.XXX,
        images: [{ nsfwLevel: NsfwLevel.XXX }],
      });
      expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X)).toBe(
        false
      );
      expect(visibleAt(items, NsfwLevel.XXX)).toBe(true);
    }
  });

  it('lets a moderator rating beat the text rating, up or down', async () => {
    let items = await feed(flagged(NsfwLevel.X), scanRow(NsfwLevel.R));
    expect(items[0]).toMatchObject({ nsfwLevel: NsfwLevel.X });
    expect(visibleAt(items, NsfwLevel.R)).toBe(false);
    expect(visibleAt(items, NsfwLevel.X)).toBe(true);
    items = await feed(flagged(NsfwLevel.PG13), scanRow(NsfwLevel.X));
    expect(items[0]).toMatchObject({ nsfwLevel: NsfwLevel.PG13 });
    expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13)).toBe(true);
    // The handler skips the text lookup for a moderator-rated bounty; the level must not depend on that.
    const bounty = { nsfw: true, nsfwLevel: 60 };
    expect(bountyNsfwFlagLevel({ ...bounty, moderatorNsfwLevel: NsfwLevel.X }, NsfwLevel.R)).toBe(
      NsfwLevel.X
    );
    expect(
      bountyNsfwFlagLevel({ ...bounty, moderatorNsfwLevel: NsfwLevel.PG13 }, NsfwLevel.X)
    ).toBe(NsfwLevel.PG13);
  });

  it('keeps a moderator rating with no browsing level XXX-only', async () => {
    const items = await feed(flagged(NsfwLevel.Blocked), scanRow(NsfwLevel.R));
    expect(items[0]).toMatchObject({ nsfwLevel: NsfwLevel.XXX });
    expect(visibleAt(items, NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R | NsfwLevel.X)).toBe(false);
  });

  it('never shows an image below its own level', async () => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([flagged()]);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(scanRow(NsfwLevel.R));
    mockImagesForBounties.mockResolvedValue({
      1: [{ id: 10, userId: 5, nsfwLevel: NsfwLevel.X, nsfwLefel: NsfwLevel.X, tags: [] }],
    });
    const { items } = await getInfiniteBountiesHandler({ input: feedInput, ctx: stranger });
    expect(items[0].images[0].nsfwLevel).toBe(NsfwLevel.X);
  });

  it('never sends the moderator rating field to the client', async () => {
    const items = await feed(flagged(NsfwLevel.X), []);
    expect(items[0]).not.toHaveProperty('moderatorNsfwLevel');
  });
});

describe('an nsfw-flagged bounty page', () => {
  // A queued answer a test does not consume would otherwise reach the next one.
  beforeEach(() => dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]));
  const page = async (moderatorNsfwLevel: number | null, rows: object[]) => {
    mockAssert.mockResolvedValue(undefined);
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      id: 9,
      name: 'B',
      availability: 'Public',
      poi: false,
      nsfw: true,
      nsfwLevel: 60,
      moderatorNsfwLevel,
      user: { id: 5 },
      details: null,
      tags: [],
      meta: {},
    });
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(rows);
    mockBountyImages.mockResolvedValue([
      { id: 10, nsfwLevel: NsfwLevel.PG, tags: [] },
      { id: 11, nsfwLevel: NsfwLevel.X, tags: [] },
    ]);
    const bounty = await getBountyHandler({ input: { id: 9 }, ctx: stranger });
    return { levels: bounty.images.map((i) => i.nsfwLevel), bounty };
  };
  const scanned = (scanLevel: number) => [
    { id: 9, byScan: true, scanCurrent: true, scanLevel, scanVersion: '1', content: NsfwLevel.PG },
  ];

  it('lifts its images to the rated level, never below their own', async () => {
    expect((await page(null, scanned(NsfwLevel.R))).levels).toEqual([NsfwLevel.R, NsfwLevel.X]);
    expect((await page(NsfwLevel.R, [])).levels).toEqual([NsfwLevel.R, NsfwLevel.X]);
  });

  // An unrated nsfw flag fails closed to XXX on the page as on the feed (#10178).
  it('shows the images of a flag with no recorded rating at XXX', async () => {
    const { levels, bounty } = await page(null, []);
    expect(levels).toEqual([NsfwLevel.XXX, NsfwLevel.XXX]);
    expect(bounty.nsfwLevel).toBe(NsfwLevel.XXX);
  });

  it('never sends the moderator rating field to the client', async () => {
    expect((await page(NsfwLevel.R, [])).bounty).not.toHaveProperty('moderatorNsfwLevel');
  });
});

describe('a minor-flagged image a bounty flag raises into the mature range', () => {
  beforeEach(() => dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]));
  const MINOR = 10;
  const CONTROL = 11;
  const viewers = {
    stranger,
    owner: { user: { id: 5 }, ...uncapped } as never,
    moderator: { user: { id: 7, isModerator: true }, ...uncapped } as never,
  };
  const listed = async (ctx: never) => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'B',
        nsfw: true,
        nsfwLevel: 60,
        moderatorNsfwLevel: null,
        tags: [],
        user: { id: 5 },
      },
    ]);
    mockImagesForBounties.mockResolvedValue({
      1: [
        {
          id: MINOR,
          userId: 5,
          minor: true,
          nsfwLevel: NsfwLevel.PG,
          nsfwLefel: NsfwLevel.PG,
          tags: [],
        },
        {
          id: CONTROL,
          userId: 5,
          minor: false,
          nsfwLevel: NsfwLevel.PG,
          nsfwLefel: NsfwLevel.PG,
          tags: [],
        },
      ],
    });
    const { items } = await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx,
    });
    return (items[0]?.images ?? []).map((i: { id: number }) => i.id);
  };
  const pagedAt = (moderatorNsfwLevel: number | null) => async (ctx: never) => {
    mockAssert.mockResolvedValue(undefined);
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      id: 9,
      name: 'B',
      availability: 'Public',
      poi: false,
      nsfw: true,
      nsfwLevel: 60,
      moderatorNsfwLevel,
      user: { id: 5 },
      details: null,
      tags: [],
      meta: {},
    });
    mockBountyImages.mockResolvedValue([
      { id: MINOR, userId: 5, minor: true, nsfwLevel: NsfwLevel.PG, tags: [] },
      { id: CONTROL, userId: 5, minor: false, nsfwLevel: NsfwLevel.PG, tags: [] },
    ]);
    const bounty = await getBountyHandler({ input: { id: 9 }, ctx });
    return bounty.images.map((i) => i.id);
  };

  const paged = pagedAt(NsfwLevel.R);
  const pagedUnrated = pagedAt(null);

  it.each([
    ['feed', listed],
    ['page', paged],
    ['page of an unrated flag', pagedUnrated],
  ] as const)('is withheld from a stranger on the %s, beside a served control', async (_, read) => {
    expect(await read(viewers.stranger)).toEqual([CONTROL]);
  });

  it('is withheld from a signed-out viewer on the page of an unrated flag, as on the feed', async () => {
    const signedOut = uncapped as never;
    const page = await pagedUnrated(signedOut);
    expect(page).not.toContain(MINOR);
    expect(page).toEqual(await listed(signedOut));
  });

  it.each([
    ['feed', 'owner', listed],
    ['feed', 'moderator', listed],
    ['page', 'owner', paged],
    ['page', 'moderator', paged],
    ['page of an unrated flag', 'owner', pagedUnrated],
    ['page of an unrated flag', 'moderator', pagedUnrated],
  ] as const)('is served on the %s to its %s', async (_, who, read) => {
    expect(await read(viewers[who])).toEqual([MINOR, CONTROL]);
  });
});

describe('the bounty page shows images by the same rule as the bounty feed (#10178)', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]);
    mockAssert.mockResolvedValue(undefined);
  });
  // A rated flag reads no text rating, so its queued answer would reach the next describe.
  afterEach(() => dbMock.dbRead.$queryRaw.mockReset());
  const OWNER = 5;
  const images = [
    { id: 10, userId: OWNER, minor: false, nsfwLevel: NsfwLevel.PG, tags: [] },
    { id: 11, userId: OWNER, minor: false, nsfwLevel: NsfwLevel.R, tags: [] },
  ];
  const bounty = (moderatorNsfwLevel: number | null, nsfw = true) => ({
    id: 9,
    name: 'B',
    nsfw,
    nsfwLevel: 60,
    moderatorNsfwLevel,
    tags: [],
    user: { id: OWNER },
  });
  const textRatedR = [
    {
      id: 9,
      byScan: true,
      scanCurrent: true,
      scanLevel: NsfwLevel.R,
      scanVersion: '1',
      content: NsfwLevel.PG,
    },
  ];
  const shown = (list: { id: number; nsfwLevel: number }[]) =>
    list.map(({ id, nsfwLevel }) => ({ id, nsfwLevel }));
  const fromFeed = async (
    moderatorNsfwLevel: number | null,
    rows: object[],
    ctx: object,
    nsfw = true
  ) => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([bounty(moderatorNsfwLevel, nsfw)]);
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(rows);
    mockImagesForBounties.mockResolvedValue({
      9: images.map((image) => ({ ...image, nsfwLefel: image.nsfwLevel })),
    });
    const { items } = await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx: ctx as never,
    });
    return { images: shown(items[0]?.images ?? []), nsfwLevel: items[0]?.nsfwLevel };
  };
  const fromPage = async (
    moderatorNsfwLevel: number | null,
    rows: object[],
    ctx: object,
    nsfw = true
  ) => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      ...bounty(moderatorNsfwLevel, nsfw),
      availability: 'Public',
      poi: false,
      details: null,
      meta: {},
    });
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce(rows);
    mockBountyImages.mockResolvedValue(images);
    const page = await getBountyHandler({ input: { id: 9 }, ctx: ctx as never });
    return { images: shown(page.images), nsfwLevel: page.nsfwLevel };
  };
  const viewers = {
    'a signed-in viewer on a capped site': { user: { id: 6 }, features: { canViewNsfw: false } },
    'a signed-out viewer on a capped site': { features: { canViewNsfw: false } },
    'a signed-in viewer on an uncapped site': stranger,
  };
  type Viewer = keyof typeof viewers;
  // [moderator rating, text-rating rows, nsfw flag, bounty level, images the feed shows per viewer]
  const flags: Record<string, [number | null, object[], boolean, number, Record<Viewer, number>]> =
    {
      'no flag': [
        null,
        [],
        false,
        60,
        {
          'a signed-in viewer on a capped site': 1,
          'a signed-out viewer on a capped site': 1,
          'a signed-in viewer on an uncapped site': 2,
        },
      ],
      'a flag with no recorded rating': [
        null,
        [],
        true,
        NsfwLevel.XXX,
        {
          'a signed-in viewer on a capped site': 0,
          'a signed-out viewer on a capped site': 0,
          'a signed-in viewer on an uncapped site': 2,
        },
      ],
      'a flag with a text rating of R': [
        null,
        textRatedR,
        true,
        NsfwLevel.R,
        {
          'a signed-in viewer on a capped site': 0,
          'a signed-out viewer on a capped site': 0,
          'a signed-in viewer on an uncapped site': 2,
        },
      ],
      'a flag with a moderator rating of R': [
        NsfwLevel.R,
        [],
        true,
        NsfwLevel.R,
        {
          'a signed-in viewer on a capped site': 0,
          'a signed-out viewer on a capped site': 0,
          'a signed-in viewer on an uncapped site': 2,
        },
      ],
    };

  it.each(
    Object.keys(flags).flatMap((flag) => Object.keys(viewers).map((viewer) => [flag, viewer]))
  )('%s, for %s', async (flag, viewer) => {
    const [level, rows, nsfw, bountyLevel, visible] = flags[flag];
    const ctx = viewers[viewer as Viewer];
    const feed = await fromFeed(level, [...rows], ctx, nsfw);
    const page = await fromPage(level, [...rows], ctx, nsfw);
    expect(feed.images).toHaveLength(visible[viewer as Viewer]);
    expect(page.images).toEqual(feed.images);
    expect(page.nsfwLevel).toBe(bountyLevel);
    // The feed drops a bounty left with no image, so only a listed one has a level to compare.
    expect(feed.nsfwLevel).toBe(visible[viewer as Viewer] ? bountyLevel : undefined);
  });
});

describe('bounty images keep their moderation state for their uploader and moderators only (#10178)', () => {
  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]);
    mockAssert.mockResolvedValue(undefined);
  });
  const UPLOADER = 5;
  const moderation = {
    minor: false,
    poi: false,
    needsReview: 'poi',
    blockedFor: null,
    ingestion: 'Scanned',
  };
  const fields = Object.keys(moderation);
  const blocked = {
    id: 12,
    userId: UPLOADER,
    nsfwLevel: NsfwLevel.Blocked,
    tags: [],
    ...moderation,
  };
  const safe = { id: 10, userId: UPLOADER, nsfwLevel: NsfwLevel.PG, tags: [], ...moderation };
  const unratedBounty = {
    id: 9,
    name: 'B',
    nsfw: true,
    nsfwLevel: 60,
    moderatorNsfwLevel: null,
    tags: [],
    user: { id: UPLOADER },
  };
  const fromPage = async (ctx: object, images: object[]) => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      ...unratedBounty,
      availability: 'Public',
      poi: false,
      details: null,
      meta: {},
    });
    mockBountyImages.mockResolvedValue(images);
    return (await getBountyHandler({ input: { id: 9 }, ctx: ctx as never })).images as Record<
      string,
      unknown
    >[];
  };
  const fromFeed = async (ctx: object, images: { nsfwLevel: number }[]) => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([unratedBounty]);
    mockImagesForBounties.mockResolvedValue({
      9: images.map((image) => ({ ...image, nsfwLefel: image.nsfwLevel })),
    });
    const { items } = await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx: ctx as never,
    });
    return (items[0]?.images ?? []) as Record<string, unknown>[];
  };
  const viewers = {
    uploader: { user: { id: UPLOADER }, ...uncapped },
    moderator: { user: { id: 7, isModerator: true }, ...uncapped },
  };
  const reads = { page: fromPage, feed: fromFeed } as const;

  it.each(['page', 'feed'] as const)('the %s sends a stranger none of them', async (read) => {
    const [image] = await reads[read](stranger, [safe]);
    expect(image.id).toBe(safe.id);
    for (const field of fields) expect(image).not.toHaveProperty(field);
  });

  it.each([
    ['page', 'uploader'],
    ['page', 'moderator'],
    ['feed', 'uploader'],
    ['feed', 'moderator'],
  ] as const)('the %s sends them to its %s', async (read, who) => {
    const [image] = await reads[read](viewers[who], [safe]);
    expect(image).toMatchObject(moderation);
  });

  // An unrated flag raises images to XXX and never lowers one (#10178).
  it.each([
    ['page', 'uploader'],
    ['page', 'moderator'],
    ['feed', 'uploader'],
    ['feed', 'moderator'],
  ] as const)(
    'the %s keeps a Blocked image Blocked for its %s under an unrated flag',
    async (read, who) => {
      const images = await reads[read](viewers[who], [safe, blocked]);
      expect(images.map((i) => [i.id, i.nsfwLevel])).toEqual([
        [safe.id, NsfwLevel.XXX],
        [blocked.id, NsfwLevel.Blocked],
      ]);
    }
  );
});

describe('entry detail image count', () => {
  const OWNER = 5;
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    id: 100 + i,
    entityId: 3,
    nsfwLevel: 1,
    tags: [],
  }));
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

describe('bounty images and browsing-tag rules', () => {
  const CHILD_TAG = childBrowsingTagIds[0];
  const OTHER_TAG = 999001;
  const mature = {
    id: 6,
    isModerator: false,
    showNsfw: true,
    browsingLevel: allBrowsingLevelsFlag,
  };
  const matureViewer = { user: mature, ...uncapped };
  const modViewer = { user: { ...mature, isModerator: true }, ...uncapped };
  const image = (id: number, tagId: number) => ({
    id,
    userId: 5,
    nsfwLevel: NsfwLevel.R,
    nsfwLefel: NsfwLevel.R,
    tags: [{ id: tagId, name: 't' }],
  });
  const ids = (images: { id: number }[]) => images.map((i) => i.id);

  const feedIds = async (ctx: object) => {
    dbMock.dbRead.bounty.findMany.mockResolvedValue([
      { id: 1, name: 'B', nsfw: false, nsfwLevel: NsfwLevel.R, tags: [], user: { id: 5 } },
    ]);
    mockImagesForBounties.mockResolvedValue({ 1: [image(10, CHILD_TAG), image(11, OTHER_TAG)] });
    const { items } = await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx: ctx as never,
    });
    return ids(items[0].images);
  };
  const detailIds = async (ctx: object) => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      id: 9,
      name: 'B',
      availability: 'Public',
      poi: false,
      user: { id: 5 },
      details: null,
      tags: [],
      meta: {},
    });
    mockBountyImages.mockResolvedValue([image(10, CHILD_TAG), image(11, OTHER_TAG)]);
    return ids((await getBountyHandler({ input: { id: 9 }, ctx: ctx as never })).images);
  };

  const entryIds = async (ctx: object) => {
    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: 5 } }] as never);
    mockImagesByEntity.mockResolvedValue([
      { ...image(30, CHILD_TAG), entityId: 3 },
      { ...image(31, OTHER_TAG), entityId: 3 },
    ]);
    const list = await getBountyEntriesHandler({ input: { id: 9 } as never, ctx: ctx as never });
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: ctx as never });
    return { list: ids(list.items[0].images), entry: ids(entry.images) };
  };

  beforeEach(() => mockAssert.mockResolvedValue(undefined));

  it('drops a child-tagged image for a mature non-moderator, keeping other mature images', async () => {
    expect(await feedIds(matureViewer)).toEqual([11]);
    expect(await detailIds(matureViewer)).toEqual([11]);
    expect(await entryIds(matureViewer)).toEqual({ list: [31], entry: [31] });
  });

  it('serves a moderator every image', async () => {
    expect(await feedIds(modViewer)).toEqual([10, 11]);
    expect(await detailIds(modViewer)).toEqual([10, 11]);
    expect(await entryIds(modViewer)).toEqual({ list: [30, 31], entry: [30, 31] });
  });

  it('drops a POI or minor-flagged image for a mature non-moderator', async () => {
    const flagged = (id: number, flag: object, entityId = 0) => ({
      ...image(id, OTHER_TAG),
      ...flag,
      entityId,
    });
    dbMock.dbRead.bounty.findMany.mockResolvedValue([
      { id: 1, name: 'B', nsfw: false, nsfwLevel: NsfwLevel.R, tags: [], user: { id: 5 } },
    ]);
    mockImagesForBounties.mockResolvedValue({
      1: [flagged(10, { poi: true }), flagged(11, { minor: true }), flagged(12, {})],
    });
    const feed = await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx: matureViewer as never,
    });
    expect(ids(feed.items[0].images)).toEqual([12]);

    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: 5 } }] as never);
    mockImagesByEntity.mockResolvedValue([
      flagged(30, { poi: true }, 3),
      flagged(31, { minor: true }, 3),
      flagged(32, {}, 3),
    ]);
    const entry = await getBountyEntryHandler({ input: { id: 3 }, ctx: matureViewer as never });
    expect(ids(entry.images)).toEqual([32]);
    const modEntry = await getBountyEntryHandler({ input: { id: 3 }, ctx: modViewer as never });
    expect(ids(modEntry.images)).toEqual([30, 31, 32]);
  });

  it('reads tags for entry detail images', async () => {
    await entryIds(matureViewer);
    expect(mockImagesByEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 3, include: ['tags'] })
    );
  });
});

// A session, or a full-access key, carries the owner's view: the entry's own held images show to
// their uploader. A scoped key or an app token does not.
describe("bounty entry images and the owner's view", () => {
  const OWNER = 5;
  const session = { user: { id: OWNER }, ...uncapped } as never;
  const scopedKey = {
    user: { id: OWNER },
    apiKeyId: 7,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 7 },
    tokenScope: TokenScope.MediaRead,
    ...uncapped,
  } as never;

  beforeEach(() => {
    mockAssert.mockResolvedValue(undefined);
    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: OWNER } }] as never);
  });

  it.each([
    [
      'getBountyEntries',
      (ctx: never) => getBountyEntriesHandler({ input: { id: 9 } as never, ctx }),
    ],
    ['getBountyEntry', (ctx: never) => getBountyEntryHandler({ input: { id: 3 }, ctx })],
  ] as const)('%s asks for the owner view on a session only', async (_name, call) => {
    await call(session);
    expect(mockImagesByEntity).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: OWNER, ownerSeesHeld: true })
    );
    await call(scopedKey);
    expect(mockImagesByEntity).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: OWNER, ownerSeesHeld: false })
    );
  });
});

// The same two reads with getImagesByEntity's real query on an in-process Postgres: an entry's own
// held image reaches its uploader on a session, not on a MediaRead-scoped key, never a stranger.
describe("bounty entry images and the owner's view, against the real image query", () => {
  const OWNER = 5;
  const CLEAN = 101;
  const HELD = 106;
  const session = { user: { id: OWNER }, ...uncapped } as never;
  const scopedKey = {
    user: { id: OWNER },
    apiKeyId: 7,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 7 },
    tokenScope: TokenScope.MediaRead,
    ...uncapped,
  } as never;
  const otherUser = { user: { id: 20 }, ...uncapped } as never;
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
      CREATE TABLE "Image" (
        id int PRIMARY KEY, name text, url text, "nsfwLevel" int DEFAULT 1, width int, height int,
        hash text, "hideMeta" boolean DEFAULT false, meta jsonb, "createdAt" timestamp DEFAULT now(),
        "mimeType" text, type text DEFAULT 'image', metadata jsonb, "scannedAt" timestamp,
        "needsReview" text, "blockedFor" text, "userId" int DEFAULT ${OWNER}, index int DEFAULT 0,
        poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
        "modelRestricted" boolean NOT NULL DEFAULT false,
        "acceptableMinor" boolean NOT NULL DEFAULT false,
        "tosViolation" boolean NOT NULL DEFAULT false
      );
      CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
      INSERT INTO "Image" (id, "needsReview", index) VALUES (${CLEAN}, NULL, 0), (${HELD}, 'csam', 1);
      INSERT INTO "ImageConnection" VALUES (${CLEAN}, 3, 'BountyEntry'), (${HELD}, 3, 'BountyEntry');
    `);
  });
  afterAll(() => pg.close());

  beforeEach(async () => {
    const actual = await vi.importActual<typeof ImageService>('~/server/services/image.service');
    mockImagesByEntity.mockImplementation(actual.getImagesByEntity as never);
    (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      pgliteRaw(pg).queryRaw
    );
    // The entry's image tags are a cache read beside the image query; they are not under test.
    vi.spyOn(imageTagsCache, 'fetch').mockResolvedValue({});
    mockAssert.mockResolvedValue(undefined);
    mockGetEntries.mockResolvedValue([{ id: 3, user: { id: OWNER } }] as never);
    mockGetEntryById.mockResolvedValue({ id: 3, user: { id: OWNER } } as never);
  });
  afterEach(() => {
    mockImagesByEntity.mockReset().mockResolvedValue([]);
    vi.restoreAllMocks();
  });

  const entryIdsFor = async (ctx: never) =>
    ((await getBountyEntryHandler({ input: { id: 3 }, ctx })).images as { id: number }[])
      .map((i) => i.id)
      .sort();
  const entriesIdsFor = async (ctx: never) =>
    (
      ((await getBountyEntriesHandler({ input: { id: 9 } as never, ctx })).items[0]?.images ??
        []) as { id: number }[]
    )
      .map((i) => i.id)
      .sort();

  describe.each([
    ['getBountyEntry', entryIdsFor],
    ['getBountyEntries', entriesIdsFor],
  ] as const)('%s', (_name, imageIds) => {
    it('shows the held image to its uploader on a session', async () => {
      expect(await imageIds(session)).toEqual([CLEAN, HELD]);
    });
    it('keeps it from its uploader on a MediaRead-scoped key', async () => {
      expect(await imageIds(scopedKey)).toEqual([CLEAN]);
    });
    it('keeps it from another signed-in user', async () => {
      expect(await imageIds(otherUser)).toEqual([CLEAN]);
    });
  });
});

// The held-media viewer rule (src/pages/api/mod/held-media): a moderator holding the csamReports grant.
describe('who the bounty reads treat as a held-media viewer', () => {
  beforeEach(() => {
    mockAssert.mockResolvedValue(undefined);
    dbMock.dbRead.$queryRaw.mockReset().mockResolvedValue([]);
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      id: 9,
      name: 'B',
      availability: 'Public',
      poi: false,
      nsfw: false,
      nsfwLevel: 1,
      moderatorNsfwLevel: null,
      user: { id: 5 },
      details: null,
      tags: [],
      meta: {},
    });
    dbMock.dbRead.bounty.findMany.mockResolvedValue([]);
  });
  afterEach(() => dbMock.dbRead.$queryRaw.mockReset());
  const viewers = {
    'a moderator with the grant': [{ id: 7, isModerator: true }, { csamReports: true }, true],
    'a moderator without it': [{ id: 7, isModerator: true }, { csamReports: false }, false],
    'a grant without moderator': [{ id: 6 }, { csamReports: true }, false],
    'a signed-out visitor': [undefined, { csamReports: false }, false],
    'a moderator with the grant on a MediaRead-scoped key': [
      { id: 7, isModerator: true },
      { csamReports: true },
      false,
      {
        apiKeyId: 7,
        apiKeyType: 'User',
        subject: { type: 'apiKey', id: 7 },
        tokenScope: TokenScope.MediaRead,
      },
    ],
  } as const;

  it.each(Object.keys(viewers))('%s', async (who) => {
    const [user, flags, sees, credential] = viewers[who as keyof typeof viewers] as readonly [
      unknown,
      object,
      boolean,
      object?
    ];
    const ctx = { user, features: { canViewNsfw: true, ...flags }, ...credential } as never;
    await getBountyHandler({ input: { id: 9 }, ctx });
    dbMock.dbRead.bounty.findMany.mockResolvedValue([
      {
        id: 9,
        name: 'B',
        nsfw: false,
        nsfwLevel: 1,
        moderatorNsfwLevel: null,
        tags: [],
        user: { id: 5 },
      },
    ]);
    await getInfiniteBountiesHandler({
      input: { limit: 10, period: 'AllTime', sort: 'Newest' } as never,
      ctx,
    });
    expect(mockBountyImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ seesReportListed: sees, ownerSeesReportListed: !credential })
    );
    expect(mockImagesForBounties).toHaveBeenLastCalledWith(
      expect.objectContaining({ seesReportListed: sees, ownerSeesReportListed: !credential })
    );
  });
});

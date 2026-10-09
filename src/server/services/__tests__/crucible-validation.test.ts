import { BuzzApiError } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelFlagsFindMany } from '~/server/services/__tests__/fixtures/model-flags-find-many';
import {
  calculateCrucibleSetupCost,
  cancelCrucibleSchema,
  createCrucibleInputSchema,
  crucibleImageSchema,
  updateCrucibleSchema,
  getCruciblesInfiniteSchema,
  getJudgingPairSchema,
  submitEntrySchema,
  submitVoteSchema,
} from '~/server/schema/crucible.schema';
import { constants } from '~/server/common/constants';
import { baseModelRecords } from '~/shared/constants/basemodel.constants';
import { CrucibleSort } from '~/server/common/enums';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock, loggingMock, redisMock } from '~/__tests__/mocks';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as PostService from '~/server/services/post.service';
import type * as Caches from '~/server/redis/caches';
import {
  CRUCIBLE_DESCRIPTION_MAX_LENGTH,
  CRUCIBLE_ENTRIES_CLOSED_MESSAGE,
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_PRIZE_POSITIONS,
  CRUCIBLE_MAX_TOTAL_ENTRIES,
  CRUCIBLE_MIN_ENTRY_FEE,
  CRUCIBLE_MIN_TOTAL_ENTRIES,
  CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_MAX_ALLOWED_BASE_MODELS,
  CRUCIBLE_MAX_ALLOWED_RESOURCES,
  CRUCIBLE_NAME_MAX_LENGTH,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
  getMaxCrucibleStartAt,
} from '~/shared/constants/crucible.constants';

const createNotification = vi.fn();
const createPost = vi.fn();
const afterPostPublish = vi.fn().mockResolvedValue(undefined);
const fetchImageResources = vi.fn();
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  createPost,
  afterPostPublish,
}));

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  imageResourcesCache: { fetch: fetchImageResources },
}));

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const { checkCrucibleEntryEligibility, createCrucibleEntryPost, submitEntry } = await import(
  '~/server/services/crucible.service'
);

const validCoverImage = {
  url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900',
  width: 512,
  height: 704,
};

const validCreateInput = {
  name: 'Test Crucible',
  description: 'A description',
  coverImage: validCoverImage,
  nsfwLevel: 1,
  entryFee: 100,
  entryLimit: 1,
  prizePositions: { '1': 50, '2': 30, '3': 20 },
  duration: 24,
};

describe('crucibleImageSchema', () => {
  it('accepts a Cloudflare id whose variant nibble is not RFC-4122 conformant', () => {
    // Real id from Image.url. `z.string().uuid()` rejects it under Zod 4 because the fourth
    // group starts with 7 rather than [89ab], and the user is told their upload failed.
    const result = crucibleImageSchema.safeParse({
      ...validCoverImage,
      url: '276019b4-2214-4bb8-73a8-5a20287ebd00',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a conformant id', () => {
    expect(crucibleImageSchema.safeParse(validCoverImage).success).toBe(true);
  });

  it.each([
    ['not a uuid at all', 'banana'],
    ['too few groups', '6a1c3f3d-29e5-49c1-816f'],
    ['a non-hex character', '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c9zz'],
    ['surrounding whitespace', ' 6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900 '],
    ['a full url rather than an id', 'https://example.com/image.png'],
    ['an empty string', ''],
  ])('still rejects %s', (_label, url) => {
    expect(crucibleImageSchema.safeParse({ ...validCoverImage, url }).success).toBe(false);
  });

  it('requires width and height', () => {
    expect(crucibleImageSchema.safeParse({ url: validCoverImage.url }).success).toBe(false);
  });
});

describe('createCrucibleInputSchema', () => {
  it('accepts a well-formed crucible', () => {
    expect(createCrucibleInputSchema.safeParse(validCreateInput).success).toBe(true);
  });

  it.each([0, -1, 1.5, 32, 33, 64])('rejects content level %s', (nsfwLevel) => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, nsfwLevel }).success).toBe(
      false
    );
  });

  it.each([1, 7, 31])('accepts content mask %s', (nsfwLevel) => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, nsfwLevel }).success).toBe(
      true
    );
  });

  it.each([
    [7, true],
    [31, true],
    [32, false],
    [39, false],
  ])('bounds an update mask of %s (valid: %s)', (nsfwLevel, valid) => {
    expect(updateCrucibleSchema.safeParse({ id: 1, nsfwLevel }).success).toBe(valid);
  });

  it('rejects an empty name', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, name: '   ' }).success).toBe(
      false
    );
  });

  it.each([
    ['omitted', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['null', null],
  ])('stores no description when it is %s', (_, description) => {
    const result = createCrucibleInputSchema.safeParse({ ...validCreateInput, description });
    expect(result.success).toBe(true);
    expect(result.data?.description ?? null).toBeNull();
  });

  it('trims the description', () => {
    expect(
      createCrucibleInputSchema.parse({ ...validCreateInput, description: '  A theme  ' })
        .description
    ).toBe('A theme');
  });

  it('clears a blank description on update and leaves an absent one unchanged', () => {
    expect(updateCrucibleSchema.parse({ id: 1, description: '  ' }).description).toBeNull();
    expect(updateCrucibleSchema.parse({ id: 1, description: null }).description).toBeNull();
    expect(updateCrucibleSchema.parse({ id: 1, description: ' New ' }).description).toBe('New');
    expect(updateCrucibleSchema.parse({ id: 1 })).not.toHaveProperty('description');
  });

  it('rejects a negative entry fee', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: -1 }).success).toBe(
      false
    );
  });

  it('rejects a free crucible, and any fee below the minimum — entry fees fund the prize pool', () => {
    for (const entryFee of [0, CRUCIBLE_MIN_ENTRY_FEE - 1]) {
      expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee }).success).toBe(
        false
      );
    }
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: CRUCIBLE_MIN_ENTRY_FEE })
        .success
    ).toBe(true);
  });

  it('caps the entry fee at 1,000 Buzz', () => {
    expect(CRUCIBLE_MAX_ENTRY_FEE).toBe(1_000);
  });

  it('accepts an entry fee at the cap and rejects one above it', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: CRUCIBLE_MAX_ENTRY_FEE })
        .success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryFee: CRUCIBLE_MAX_ENTRY_FEE + 1,
      }).success
    ).toBe(false);
  });

  it('requires an entry limit of at least one, capped at CRUCIBLE_MAX_ENTRIES', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, entryLimit: 0 }).success
    ).toBe(false);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryLimit: CRUCIBLE_MAX_ENTRIES,
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryLimit: CRUCIBLE_MAX_ENTRIES + 1,
      }).success
    ).toBe(false);
  });

  it('allows free entries up to the entry limit and no further', () => {
    const parse = (freeEntriesPerUser: number) =>
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryLimit: 3,
        freeEntriesPerUser,
      });

    expect(parse(0).success).toBe(true);
    expect(parse(3).success).toBe(true);
    expect(parse(4).success).toBe(false);
    expect(parse(-1).success).toBe(false);
  });

  it('defaults to no free entries', () => {
    const result = createCrucibleInputSchema.safeParse(validCreateInput);

    expect(result.success && result.data.freeEntriesPerUser).toBe(0);
  });

  it('rejects prize percentages summing above 100', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 60, '2': 50 },
      }).success
    ).toBe(false);
  });

  it('accepts prize percentages summing to exactly 100', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 100 },
      }).success
    ).toBe(true);
  });

  it('rejects prize percentages summing below 100, whose remainder no place would be paid', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...validCreateInput,
      prizePositions: { '1': 40, '2': 20 },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/exactly 100%/);
  });

  it.each([
    ['a gap in the places', { '1': 50, '3': 50 }],
    ['a place numbered from zero', { '0': 50, '1': 50 }],
    ['a non-numeric place', { first: 100 }],
    ['a fractional percentage', { '1': 50.5, '2': 49.5 }],
    ['no places at all', {}],
  ])('rejects %s', (_label, prizePositions) => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, prizePositions }).success
    ).toBe(false);
  });

  it('caps how many prize places a crucible can have', () => {
    const places = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), i === 0 ? 100 : 0]));
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: places(CRUCIBLE_MAX_PRIZE_POSITIONS),
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: places(CRUCIBLE_MAX_PRIZE_POSITIONS + 1),
      }).success
    ).toBe(false);
  });

  it('keeps max total entries inside the int4 column, which a huge value overflowed at insert', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, maxTotalEntries: 9999999999999 })
        .success
    ).toBe(false);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        maxTotalEntries: CRUCIBLE_MAX_TOTAL_ENTRIES,
      }).success
    ).toBe(true);
    expect(CRUCIBLE_MAX_TOTAL_ENTRIES).toBeLessThan(2 ** 31);
  });

  it('rejects a total cap too small to form a single judging pair', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        maxTotalEntries: CRUCIBLE_MIN_TOTAL_ENTRIES - 1,
      }).success
    ).toBe(false);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        maxTotalEntries: CRUCIBLE_MIN_TOTAL_ENTRIES,
        prizePositions: { '1': 70, '2': 30 },
      }).success
    ).toBe(true);
  });

  it('rejects more prize places than the crucible can have entrants', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...validCreateInput,
      maxTotalEntries: 2,
      prizePositions: { '1': 50, '2': 30, '3': 20 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(
      /more prize places than the maximum total entries/
    );
  });

  it('rejects more entries per user than the whole crucible allows', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...validCreateInput,
      entryLimit: 5,
      maxTotalEntries: 3,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['entryLimit']);
  });

  it('caps the name and description lengths the form already enforces', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        name: 'x'.repeat(CRUCIBLE_NAME_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        description: 'x'.repeat(CRUCIBLE_DESCRIPTION_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });

  it('defaults seededPrizePool to 0, so an omitted seed is not undefined downstream', () => {
    expect(createCrucibleInputSchema.parse(validCreateInput).seededPrizePool).toBe(0);
  });

  it('rejects a negative seeded prize pool', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, seededPrizePool: -1 }).success
    ).toBe(false);
  });

  it('rejects a fractional seeded prize pool, which Buzz cannot represent', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, seededPrizePool: 10.5 }).success
    ).toBe(false);
  });

  it('accepts a seeded prize pool at the cap and rejects one above it', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        seededPrizePool: CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        seededPrizePool: CRUCIBLE_MAX_SEEDED_PRIZE_POOL + 1,
      }).success
    ).toBe(false);
  });

  it('offers 24 hours and 3 days free, and 7 days for 1,000 Buzz', () => {
    expect(CRUCIBLE_DURATION_COSTS).toEqual({ 24: 0, 72: 0, 168: 1_000 });
  });

  it('rejects a duration below one hour', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, duration: 0 }).success).toBe(
      false
    );
  });

  it.each(Object.keys(CRUCIBLE_DURATION_COSTS))('accepts the listed %s-hour duration', (hours) => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, duration: Number(hours) }).success
    ).toBe(true);
  });

  it('accepts a start within the scheduling window', () => {
    const startAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, startAt }).success).toBe(
      true
    );
  });

  it('rejects a start past the scheduling window', () => {
    const startAt = new Date(getMaxCrucibleStartAt().getTime() + 60 * 60 * 1000);
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, startAt }).success).toBe(
      false
    );
  });

  it('caps how many resources a crucible can require', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const parse = (n: number) =>
      createCrucibleInputSchema.safeParse({ ...validCreateInput, allowedResources: ids(n) });
    expect(parse(CRUCIBLE_MAX_ALLOWED_RESOURCES).success).toBe(true);
    expect(parse(CRUCIBLE_MAX_ALLOWED_RESOURCES + 1).success).toBe(false);
  });

  it('rejects an unlisted duration, which the cost table would otherwise price as free', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, duration: 9999 }).success
    ).toBe(false);
  });

  it('defaults contentType to image, so existing crucibles behave unchanged', () => {
    expect(createCrucibleInputSchema.parse(validCreateInput).contentType).toBe(MediaType.image);
  });

  it('accepts video as a content type', () => {
    expect(
      createCrucibleInputSchema.parse({ ...validCreateInput, contentType: MediaType.video })
        .contentType
    ).toBe(MediaType.video);
  });

  it('rejects audio as a content type — entries are judged by looking at them', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, contentType: MediaType.audio })
        .success
    ).toBe(false);
  });
});

describe('calculateCrucibleSetupCost', () => {
  it.each(Object.entries(CRUCIBLE_DURATION_COSTS))(
    'charges %s hours at its listed cost when prizes are not customized',
    (duration, cost) => {
      expect(calculateCrucibleSetupCost(Number(duration), false)).toBe(cost);
    }
  );

  it('adds the customization fee on top of the duration cost', () => {
    expect(calculateCrucibleSetupCost(168, true)).toBe(
      CRUCIBLE_DURATION_COSTS[168] + CRUCIBLE_PRIZE_CUSTOMIZATION_COST
    );
  });

  it('charges only the customization fee when the duration itself is free', () => {
    expect(CRUCIBLE_DURATION_COSTS[24]).toBe(0);
    expect(calculateCrucibleSetupCost(24, true)).toBe(CRUCIBLE_PRIZE_CUSTOMIZATION_COST);
  });

  it('adds the resource requirements fee when entries are restricted', () => {
    expect(calculateCrucibleSetupCost(24, false, true)).toBe(CRUCIBLE_RESOURCE_REQUIREMENTS_COST);
    expect(calculateCrucibleSetupCost(168, true, true)).toBe(
      CRUCIBLE_DURATION_COSTS[168] +
        CRUCIBLE_PRIZE_CUSTOMIZATION_COST +
        CRUCIBLE_RESOURCE_REQUIREMENTS_COST
    );
  });

  it('treats an unlisted duration as free rather than NaN', () => {
    expect(calculateCrucibleSetupCost(9999, false)).toBe(0);
  });
});

describe('submitEntrySchema', () => {
  it('requires both ids as numbers', () => {
    expect(submitEntrySchema.safeParse({ crucibleId: 1, imageId: 2 }).success).toBe(true);
    expect(submitEntrySchema.safeParse({ crucibleId: '1', imageId: 2 }).success).toBe(false);
    expect(submitEntrySchema.safeParse({ crucibleId: 1 }).success).toBe(false);
  });
});

describe('submitVoteSchema', () => {
  it('requires the crucible and both entry ids', () => {
    expect(
      submitVoteSchema.safeParse({ crucibleId: 1, winnerEntryId: 2, loserEntryId: 3 }).success
    ).toBe(true);
    expect(submitVoteSchema.safeParse({ crucibleId: 1, winnerEntryId: 2 }).success).toBe(false);
  });
});

describe('getJudgingPairSchema', () => {
  it('allows the exclude list to be omitted', () => {
    expect(getJudgingPairSchema.safeParse({ crucibleId: 1 }).success).toBe(true);
  });

  it('caps the exclude list at 50 entries', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(
      getJudgingPairSchema.safeParse({ crucibleId: 1, excludeEntryIds: ids(50) }).success
    ).toBe(true);
    expect(
      getJudgingPairSchema.safeParse({ crucibleId: 1, excludeEntryIds: ids(51) }).success
    ).toBe(false);
  });
});

describe('cancelCrucibleSchema', () => {
  it('requires a numeric id', () => {
    expect(cancelCrucibleSchema.safeParse({ id: 1 }).success).toBe(true);
    expect(cancelCrucibleSchema.safeParse({ id: 'one' }).success).toBe(false);
  });
});

describe('getCruciblesInfiniteSchema', () => {
  it('defaults sort to PrizePool and limit to 20', () => {
    const parsed = getCruciblesInfiniteSchema.parse({});
    expect(parsed.sort).toBe(CrucibleSort.PrizePool);
    expect(parsed.limit).toBe(20);
  });

  it('coerces a string limit, since it arrives from a query string', () => {
    expect(getCruciblesInfiniteSchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects a limit above 200', () => {
    expect(getCruciblesInfiniteSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('rejects an unknown sort', () => {
    expect(getCruciblesInfiniteSchema.safeParse({ sort: 'Whatever' }).success).toBe(false);
  });
});

const CRUCIBLE_STARTED_AT = new Date(Date.now() - 60 * 60_000);

const crucibleRow = (contentType: MediaType, maxClipSeconds: number | null = null) => ({
  id: 1,
  name: 'Test Crucible',
  userId: 99,
  status: CrucibleStatus.Active,
  buzzType: 'yellow',
  nsfwLevel: 1,
  contentType,
  entryFee: 0,
  entryLimit: 1,
  freeEntriesPerUser: 0,
  maxTotalEntries: null,
  minViewSeconds: null,
  maxClipSeconds,
  allowedResources: null as number[] | null,
  allowedBaseModels: [] as string[],
  startAt: CRUCIBLE_STARTED_AT,
  createdAt: CRUCIBLE_STARTED_AT,
  endAt: new Date(Date.now() + 60_000),
  ingestion: 'Scanned',
  textNsfw: false,
  image: { ingestion: 'Scanned' },
  _count: { entries: 0 },
});

const imageRow = (type: MediaType, metadata: Record<string, unknown> | null = null) => ({
  id: 7,
  userId: 42,
  type,
  nsfwLevel: 1,
  metadata,
  ingestion: 'Scanned',
  createdAt: new Date(CRUCIBLE_STARTED_AT.getTime() + 60_000),
});

const submit = () => submitEntry({ crucibleId: 1, imageId: 7, userId: 42 });

beforeEach(() => {
  // The insert's locked check that the crucible is still open.
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  redisMock.sysRedis.set.mockResolvedValue('OK');
});

describe('submitEntry — content type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({
      id: 5,
      user: { username: 'tester' },
    });
  });

  it('accepts an image in an image crucible — the pre-video behaviour', async () => {
    await expect(submit()).resolves.toMatchObject({ id: 5 });
    expect(dbMock.dbWrite.crucibleEntry.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an image still being scanned, which judging would never show', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ...imageRow(MediaType.image),
      ingestion: 'Pending',
    });

    await expect(submit()).rejects.toThrow(/still being checked/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it.each([
    ['its text is still being scanned', { ingestion: 'Pending' }],
    ['its cover has not passed its scan', { image: { ingestion: 'Blocked' } }],
  ])('refuses an entry while %s', async (_, override) => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      ...override,
    });

    await expect(submit()).rejects.toThrow(/not found/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('rejects an image that is neither published nor a draft of the caller', async () => {
    dbMock.dbRead.image.count.mockResolvedValue(0);
    dbMock.dbRead.image.findFirst.mockResolvedValue(null);

    await expect(submit()).rejects.toThrow(/Only published images can be entered/);
    expect(dbMock.dbRead.image.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 7, post: { publishedAt: { lte: expect.any(Date) } } }),
    });
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  const draftOf = (post: { images?: number; metadata?: Record<string, unknown> | null } = {}) => {
    dbMock.dbRead.image.count.mockResolvedValue(0);
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      postId: 300,
      post: {
        metadata: 'metadata' in post ? post.metadata : { crucibleEntryDraft: true },
        _count: { images: post.images ?? 1 },
      },
    });
    dbMock.dbWrite.post.updateMany.mockResolvedValue({ count: 1 });
  };

  it("enters the caller's own draft image and schedules its post for the crucible's end", async () => {
    const endAt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      endAt,
    });
    draftOf();

    await expect(submit()).resolves.toMatchObject({ id: 5 });
    expect(dbMock.dbRead.image.findFirst).toHaveBeenCalledWith({
      where: {
        id: 7,
        needsReview: null,
        tosViolation: false,
        post: { userId: 42, publishedAt: null },
      },
      select: {
        postId: true,
        post: { select: { metadata: true, _count: { select: { images: true } } } },
      },
    });
    expect(dbMock.dbWrite.post.updateMany).toHaveBeenCalledWith({
      where: { id: 300, userId: 42, publishedAt: null },
      data: { publishedAt: endAt },
    });
    expect(afterPostPublish).toHaveBeenCalledWith({ postId: 300, userId: 42 });
  });

  it('leaves the draft unpublished when the crucible closed before the entry was saved', async () => {
    draftOf();
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await expect(submit()).rejects.toThrow(/not accepting entries/);
    expect(dbMock.dbWrite.post.updateMany).not.toHaveBeenCalled();
    expect(afterPostPublish).not.toHaveBeenCalled();
  });

  it.each([
    ['holds other images, which entering one would publish', { images: 2 }],
    [
      'was unpublished with its model, so it keeps its original date',
      { metadata: { crucibleEntryDraft: true, prevPublishedAt: '2026-01-01' } },
    ],
    // A collection or model-showcase draft would skip the checks its own publish path runs.
    ['the entry modal did not create', { metadata: null }],
    ['carries other metadata but not the entry-modal marker', { metadata: { other: true } }],
  ])('refuses a draft that %s', async (_, post) => {
    draftOf(post);

    await expect(submit()).rejects.toThrow(/Only published images can be entered/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('leaves an already published post alone', async () => {
    await submit();

    expect(dbMock.dbWrite.post.updateMany).not.toHaveBeenCalled();
    expect(afterPostPublish).not.toHaveBeenCalled();
  });

  it('saves no entry when the draft was published or moved meanwhile', async () => {
    draftOf();
    dbMock.dbWrite.post.updateMany.mockResolvedValue({ count: 0 });

    await expect(submit()).rejects.toThrow(/changed while it was being entered/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('refuses an R entry once a required model is held to PG and PG-13', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      nsfwLevel: 1 | 2 | 4,
      allowedResources: [12],
    });
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ...imageRow(MediaType.image),
      nsfwLevel: 4,
    });
    fetchImageResources.mockResolvedValue({ 7: { resources: [{ modelVersionId: 12 }] } });
    dbMock.dbRead.modelVersion.findMany.mockImplementation(
      modelFlagsFindMany((id) => (id === 12 ? { minor: false, sfwOnly: true } : undefined))
    );

    await expect(submit()).rejects.toThrow(/can only be PG or PG-13/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('rejects a video in an image crucible', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video));

    await expect(submit()).rejects.toThrow(/only accepts image entries/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('accepts a video in a video crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video));
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
    expect(dbMock.dbWrite.crucibleEntry.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an image in a video crucible', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video));

    await expect(submit()).rejects.toThrow(/only accepts video entries/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });
});

describe('submitVoteSchema — watched playback', () => {
  const base = { crucibleId: 1, winnerEntryId: 2, loserEntryId: 3 };

  it('accepts the FRACTIONAL values a real client sends', () => {
    // Accumulated from `video.currentTime` deltas, so the browser sends fractions. An `.int()`
    // schema rejected every genuine vote, and every test that passed a round number passed.
    const result = submitVoteSchema.safeParse({
      ...base,
      winnerWatchedMs: 10894.686999999998,
      loserWatchedMs: 11194.383999999998,
    });

    expect(result.success).toBe(true);
  });

  it('accepts a vote with no watch times at all', () => {
    expect(submitVoteSchema.safeParse(base).success).toBe(true);
  });

  it.each([
    ['a negative duration', { winnerWatchedMs: -1 }],
    ['a non-finite duration', { winnerWatchedMs: Number.POSITIVE_INFINITY }],
    ['a string', { winnerWatchedMs: '6000' }],
  ])('rejects %s', (_label, watched) => {
    expect(submitVoteSchema.safeParse({ ...base, ...watched }).success).toBe(false);
  });
});

describe('createCrucibleInputSchema — video settings', () => {
  const videoInput = { ...validCreateInput, contentType: MediaType.video };

  it('accepts a video crucible carrying both settings', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...videoInput,
      minViewSeconds: 6,
      maxClipSeconds: 120,
    });

    expect(result.success).toBe(true);
  });

  it('accepts a video crucible carrying neither', () => {
    expect(createCrucibleInputSchema.safeParse(videoInput).success).toBe(true);
  });

  it.each([
    ['a minimum view time', { minViewSeconds: 6 }],
    ['a maximum clip length', { maxClipSeconds: 120 }],
  ])('rejects an image crucible carrying %s', (_label, settings) => {
    // The DB says the same thing via Crucible_video_settings_require_video; this is the half that
    // produces a message rather than a constraint violation.
    const result = createCrucibleInputSchema.safeParse({ ...validCreateInput, ...settings });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/video crucibles only/);
  });

  it('rejects a minimum longer than the maximum, which nothing could satisfy', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...videoInput,
      minViewSeconds: 30,
      maxClipSeconds: 10,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/cannot exceed the maximum clip length/);
  });

  it('accepts a minimum exactly equal to the maximum', () => {
    const result = createCrucibleInputSchema.safeParse({
      ...videoInput,
      minViewSeconds: 10,
      maxClipSeconds: 10,
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ['a zero minimum — absent is how "no rule" is spelled', { minViewSeconds: 0 }],
    ['a zero maximum, which would forbid every entry', { maxClipSeconds: 0 }],
    ['a fractional minimum', { minViewSeconds: 6.5 }],
    ['an unlisted minimum', { minViewSeconds: 7 }],
    ['an unlisted maximum', { maxClipSeconds: 1 }],
    ['a maximum longer than any uploadable video', { maxClipSeconds: 600 }],
  ])('rejects %s', (_label, settings) => {
    expect(createCrucibleInputSchema.safeParse({ ...videoInput, ...settings }).success).toBe(false);
  });

  it.each(CRUCIBLE_MIN_VIEW_SECONDS_OPTIONS)('accepts the listed %ss minimum', (minViewSeconds) => {
    expect(createCrucibleInputSchema.safeParse({ ...videoInput, minViewSeconds }).success).toBe(
      true
    );
  });

  it.each(CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS)('accepts the listed %ss maximum', (maxClipSeconds) => {
    expect(createCrucibleInputSchema.safeParse({ ...videoInput, maxClipSeconds }).success).toBe(
      true
    );
  });

  it('offers no maximum longer than the site accepts for an uploaded video', () => {
    expect(Math.max(...CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS)).toBeLessThanOrEqual(
      constants.mediaUpload.maxVideoDurationSeconds
    );
  });
});

describe('submitEntry — site', () => {
  const row = (overrides: Record<string, unknown>) =>
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      textNsfw: false,
      ...overrides,
    });
  const outcomeOn = (isGreen: boolean) =>
    submitEntry({ crucibleId: 1, imageId: 7, userId: 42, isGreen }).catch((error: Error) => error);
  const message = (outcome: unknown) => (outcome instanceof Error ? outcome.message : '');

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
  });

  it('refuses a crucible that accepts mature entries on the green site, before charging', async () => {
    row({ buzzType: 'yellow', nsfwLevel: 1 | 4 });
    expect(message(await outcomeOn(true))).toContain('Crucible not found');
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('refuses an SFW-rated crucible with adult text on the green site, before charging', async () => {
    row({ buzzType: 'yellow', nsfwLevel: 1, textNsfw: true });
    expect(message(await outcomeOn(true))).toContain('Crucible not found');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it("charges no moderator's green Buzz into a crucible the green site doesn't list", async () => {
    row({ buzzType: 'yellow', nsfwLevel: 1 | 4, entryFee: 50 });
    const outcome = await submitEntry({
      crucibleId: 1,
      imageId: 7,
      userId: 42,
      isGreen: true,
      isModerator: true,
    }).catch((error: Error) => error);
    expect(message(outcome)).toBe('Enter this crucible on civitai.red.');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['created in yellow, on the green site', 'yellow', true],
    ['created in green, on the mature site', 'green', false],
  ] as const)('lets an SFW crucible %s be entered', async (_, buzzType, isGreen) => {
    row({ buzzType, nsfwLevel: 1 });
    expect(message(await outcomeOn(isGreen))).not.toContain('Crucible not found');
  });
});

describe('submitEntry — maximum clip length', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video, 120));
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      imageRow(MediaType.video, { duration: 6.592 })
    );
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
  });

  it('accepts a clip under the maximum', async () => {
    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('accepts a clip exactly at the maximum', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video, { duration: 120 }));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('rejects a clip over the maximum', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      imageRow(MediaType.video, { duration: 120.01 })
    );

    await expect(submit()).rejects.toThrow(/at most 2:00/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('does not render the clip and the limit as the SAME duration', async () => {
    // `formatDuration` rounds, so a fractional overshoot printed "at most 2:00; this one is 2:00"
    // — an entrant told the entry is too long and shown two identical numbers.
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      imageRow(MediaType.video, { duration: 120.01 })
    );

    await expect(submit()).rejects.toThrow(/at most 2:00; this one is 2:01/);
  });

  it('accepts any length when the crucible sets no maximum', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video, null));
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video, { duration: 9999 }));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('accepts a video whose duration was never recorded', async () => {
    // Metadata is written by the uploader and is not guaranteed. Blocking on a missing field
    // would reject entries for a reason the entrant cannot see or fix.
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video, {}));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });
});

describe('submitEntry — entry fee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
    getUserBuzzAccount.mockResolvedValue([{ balance: 500 }]);
    createMultiAccountBuzzTransaction.mockResolvedValue(undefined);
  });

  it('names and links the crucible on the fee', async () => {
    await expect(submit()).resolves.toMatchObject({ id: 5 });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 50,
        description: 'Crucible entry fee: Test Crucible',
        details: { entityId: 1, entityType: 'Crucible' },
      })
    );
  });

  // The entrant pays in the currency of the site they enter on, never the creator's.
  it.each([
    ['green on the green site, for a crucible created in yellow', true, 'yellow', 'green'],
    ['yellow on the mature site, for a crucible created in green', false, 'green', 'yellow'],
  ] as const)('charges %s, and pools the fee', async (_, isGreen, createdIn, charged) => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
      buzzType: createdIn,
      textNsfw: false,
    });

    await expect(
      submitEntry({ crucibleId: 1, imageId: 7, userId: 42, isGreen })
    ).resolves.toMatchObject({ id: 5 });

    expect(getUserBuzzAccount).toHaveBeenCalledWith({ accountId: 42, accountTypes: [charged] });
    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(createMultiAccountBuzzTransaction.mock.calls[0][0]).toMatchObject({
      fromAccountId: 42,
      fromAccountTypes: [charged],
      amount: 50,
    });
    const [, poolIncrement] = dbMock.dbWrite.$executeRaw.mock.calls.at(-1) as [unknown, number];
    expect(poolIncrement).toBe(50);
  });

  it('refunds the fee when the entry write fails, and logs a refund that also fails', async () => {
    dbMock.dbWrite.crucibleEntry.create.mockRejectedValue(new Error('db down'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(submit()).rejects.toThrow('db down');

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(3);
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: expect.stringMatching(/^crucible-entry-1-42-/),
      })
    );
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-entry-fee-refund-failed',
        crucibleId: 1,
        userId: 42,
      })
    );
  });
});

describe('submitEntry — one submit at a time per user', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
    redisMock.sysRedis.set.mockResolvedValue('OK');
  });

  it('takes a lock that outlives a slow charge, under a token of its own', async () => {
    await submit();

    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      'lock:crucible-entry:1:42',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      { PX: 30_000, NX: true }
    );
  });

  it('releases only the lock it took, so an expired submit cannot free a later one', async () => {
    await submit();

    const token = redisMock.sysRedis.set.mock.calls[0][1];
    expect(redisMock.sysRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      { keys: ['lock:crucible-entry:1:42'], arguments: [token] }
    );
    expect(redisMock.sysRedis.del).not.toHaveBeenCalledWith('lock:crucible-entry:1:42');
  });

  it('refuses a second submit while the first holds the lock', async () => {
    redisMock.sysRedis.set.mockResolvedValue(null);

    await expect(submit()).rejects.toThrow('in progress');
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unavailable, rather than letting overlapping submits through', async () => {
    redisMock.sysRedis.set.mockRejectedValue(new Error('redis down'));

    await expect(submit()).rejects.toThrow('redis down');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });
});

describe('submitEntry — a cancel or the end landing mid-submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
    getUserBuzzAccount.mockResolvedValue([{ balance: 500 }]);
    createMultiAccountBuzzTransaction.mockResolvedValue(undefined);
    refundMultiAccountTransaction.mockResolvedValue(undefined);
  });

  const lockedCheck = () => {
    const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls.at(-1) as [
      TemplateStringsArray,
      ...unknown[]
    ];
    return { sql: strings.join('?').replace(/\s+/g, ' '), values };
  };

  it('inserts only after locking the crucible row and confirming it is still open', async () => {
    await submit();

    expect(lockedCheck().sql).toContain(
      'UPDATE "Crucible" SET "prizePool" = "prizePool" + ? WHERE id = ? AND status = ?::"CrucibleStatus" AND ("endAt" IS NULL OR "endAt" > statement_timestamp()) AND ( "startAt" IS NULL OR "endAt" IS NULL OR statement_timestamp() < "endAt" - ("endAt" - "startAt") * ("entryCutoffPercent" / 100.0) )'
    );
    expect(dbMock.dbWrite.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      dbMock.dbWrite.crucibleEntry.create.mock.invocationCallOrder[0]
    );
  });

  it("raises the stored prize pool by a paid entry's fee", async () => {
    await submit();
    expect(lockedCheck().values[0]).toBe(50);
  });

  it('leaves the stored prize pool alone for a free entry', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
      freeEntriesPerUser: 1,
    });

    await submit();

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(lockedCheck().values[0]).toBe(0);
  });

  it('retries the refund of a refused entry, and counts a duplicate as refunded', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    refundMultiAccountTransaction
      .mockRejectedValueOnce(new Error('buzz blip'))
      .mockRejectedValueOnce(new BuzzApiError(409, 'duplicate'));

    await expect(submit()).rejects.toThrow('not accepting entries');

    expect(refundMultiAccountTransaction).toHaveBeenCalledTimes(2);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-fee-refund-failed' })
    );
  });

  const paidDraft = () => {
    dbMock.dbRead.image.count.mockResolvedValue(0);
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      postId: 300,
      post: { metadata: { crucibleEntryDraft: true }, _count: { images: 1 } },
    });
    dbMock.dbWrite.post.updateMany.mockResolvedValue({ count: 1 });
  };

  // The entry and its fee are committed by then: a refund here would make it a free entry.
  it('keeps a paid draft entry and its fee when the post refresh after commit fails', async () => {
    paidDraft();
    afterPostPublish.mockRejectedValueOnce(new Error('reindex down'));

    await expect(submit()).resolves.toMatchObject({ id: 5 });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-post-refresh-failed', postId: 300 })
    );
  });

  it('refunds a paid draft entry when its post was published or moved meanwhile', async () => {
    paidDraft();
    dbMock.dbWrite.post.updateMany.mockResolvedValue({ count: 0 });

    await expect(submit()).rejects.toThrow(/changed while it was being entered/);

    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: expect.stringMatching(/^crucible-entry-1-42-/),
      })
    );
  });

  it('says entries closed, and refunds the fee, when the cutoff passes during the charge', async () => {
    const HOUR = 60 * 60_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // A 10h run with 1h left and a 5% cutoff: entries close in 30 minutes.
      dbMock.dbRead.crucible.findUnique.mockResolvedValue({
        ...crucibleRow(MediaType.image),
        entryFee: 50,
        startAt: new Date(Date.now() - 9 * HOUR),
        endAt: new Date(Date.now() + HOUR),
        entryCutoffPercent: 5,
      });
      createMultiAccountBuzzTransaction.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 31 * 60_000);
      });
      dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

      await expect(submit()).rejects.toThrow(CRUCIBLE_ENTRIES_CLOSED_MESSAGE);

      expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
      expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          externalTransactionIdPrefix: expect.stringMatching(/^crucible-entry-1-42-/),
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the entry and refunds its fee when the crucible closed after the checks', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);

    await expect(submit()).rejects.toThrow('not accepting entries');

    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: expect.stringMatching(/^crucible-entry-1-42-/),
      })
    );
  });
});

describe('submitEntry — creator notification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
  });

  const sentDetails = () =>
    createNotification.mock.calls.find(([n]) => n.type === 'crucible-entry-submitted')?.[0].details;

  it('names a crucible whose text passed its scan', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));

    await submit();

    expect(sentDetails()).toMatchObject({ crucibleId: 1, crucibleName: 'Test Crucible' });
  });

  it('leaves out a name flagged as adult text', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      textNsfw: true,
    });

    await submit();

    expect(sentDetails()).toMatchObject({ crucibleId: 1, crucibleName: null });
  });

  it('logs a notification it could not send without failing the entry', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));
    createNotification.mockRejectedValue(new Error('notifications down'));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          name: 'crucible-notification-failed',
          notificationType: 'crucible-entry-submitted',
        })
      )
    );
  });
});

describe('submitEntry — free entries', () => {
  const entryData = () => dbMock.dbWrite.crucibleEntry.create.mock.calls[0][0].data;

  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
      entryLimit: 3,
      freeEntriesPerUser: 1,
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
    getUserBuzzAccount.mockResolvedValue([{ balance: 500 }]);
    createMultiAccountBuzzTransaction.mockResolvedValue(undefined);
  });

  it("takes a person's first entry without charging, even with no Buzz", async () => {
    getUserBuzzAccount.mockResolvedValue([{ balance: 0 }]);

    await expect(submit()).resolves.toMatchObject({ id: 5 });

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    // No transaction is what keeps it out of the prize pool and out of a cancel's refunds.
    expect(entryData().buzzTransactionId).toBeNull();
  });

  it('charges the entry after the free ones', async () => {
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(1);

    await submit();

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50 })
    );
    expect(entryData().buzzTransactionId).toMatch(/^crucible-entry-1-42-/);
  });

  it("counts the entrant's own entries on the primary, so a replica can't miss the last one", async () => {
    await submit();

    expect(dbMock.dbWrite.crucibleEntry.count).toHaveBeenCalledWith({
      where: { crucibleId: 1, userId: 42 },
    });
  });

  // Entries whose image is gone (deleted or withdrawn), counted per the where clause.
  const withGoneEntries = ({ all, live }: { all: number; live: number }) =>
    dbMock.dbWrite.crucibleEntry.count.mockImplementation((async (args: {
      where: { imageId?: unknown };
    }) => ('imageId' in args.where ? live : all)) as never);

  it('reopens the slot of an entry whose image is gone, and charges the entry made in it', async () => {
    withGoneEntries({ all: 3, live: 2 });

    await expect(submit()).resolves.toMatchObject({ id: 5 });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50 })
    );
  });

  it('still charges a re-entry when the gone entry was the free one', async () => {
    withGoneEntries({ all: 1, live: 0 });

    await submit();

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50 })
    );
  });

  it('accepts while live entries are under the limit, however many entries were made', async () => {
    withGoneEntries({ all: 5, live: 2 });

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('refuses once the live entries reach the limit', async () => {
    withGoneEntries({ all: 4, live: 3 });

    await expect(submit()).rejects.toThrow(/maximum of 3 entries/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it("doesn't count entries whose image is gone toward the crucible's total cap", async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryFee: 50,
      entryLimit: 3,
      freeEntriesPerUser: 1,
      maxTotalEntries: 10,
      _count: { entries: 10 },
    });
    dbMock.dbWrite.crucibleEntry.count.mockImplementation((async (args: {
      where: { userId?: number };
    }) => (args.where.userId ? 0 : 9)) as never);

    await expect(submit()).resolves.toMatchObject({ id: 5 });
    expect(dbMock.dbWrite.crucibleEntry.count).toHaveBeenCalledWith({
      where: { crucibleId: 1, imageId: { not: null } },
    });
  });

  it("refuses once the crucible's live entries reach its total cap", async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      entryLimit: 3,
      maxTotalEntries: 10,
      _count: { entries: 12 },
    });
    dbMock.dbWrite.crucibleEntry.count.mockImplementation((async (args: {
      where: { userId?: number };
    }) => (args.where.userId ? 0 : 10)) as never);

    await expect(submit()).rejects.toThrow(/reached its maximum number of entries/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });
});

describe('createCrucibleEntryPost', () => {
  const create = (viewer: { isGreen?: boolean; blockedByUserIds?: number[] } = {}) =>
    createCrucibleEntryPost({ crucibleId: 1, userId: 42, ...viewer });
  const arena = (overrides: Record<string, unknown> = {}) => ({
    name: 'Open Arena',
    status: CrucibleStatus.Active,
    endAt: new Date(Date.now() + 60_000),
    userId: 99,
    buzzType: 'yellow',
    nsfwLevel: 1,
    ingestion: 'Scanned',
    textNsfw: false,
    image: { ingestion: 'Scanned' },
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createPost.mockResolvedValue({ id: 900 });
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(arena());
  });

  it('creates an unpublished post for the caller, marked so the picker lists it in a later session', async () => {
    await expect(create()).resolves.toEqual({ id: 900 });
    expect(createPost).toHaveBeenCalledWith({
      userId: 42,
      title: 'Open Arena',
      metadata: { crucibleEntryDraft: true },
    });
  });

  it('refuses a crucible that is no longer active', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(
      arena({ status: CrucibleStatus.Completed, endAt: new Date(Date.now() - 60_000) })
    );

    await expect(create()).rejects.toThrow(/not accepting entries/);
    expect(createPost).not.toHaveBeenCalled();
  });

  it('refuses an active crucible whose end time has passed', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(
      arena({ status: CrucibleStatus.Active, endAt: new Date(Date.now() - 60_000) })
    );

    await expect(create()).rejects.toThrow(/not accepting entries/);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("refuses the crucible's own creator", async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(
      arena({ status: CrucibleStatus.Active, endAt: new Date(Date.now() + 60_000), userId: 42 })
    );

    await expect(create()).rejects.toThrow(/can't enter a crucible you created/);
    expect(createPost).not.toHaveBeenCalled();
  });

  it.each([
    ['still under review', { ingestion: 'Pending' }, {}],
    ['accepting mature entries, on the green site', { nsfwLevel: 1 | 4 }, { isGreen: true }],
    ['whose creator blocked the caller', {}, { blockedByUserIds: [99] }],
  ])('is not found for a crucible %s, and creates no post', async (_, crucible, viewer) => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(arena(crucible));

    await expect(create(viewer)).rejects.toThrow('Crucible not found');
    expect(createPost).not.toHaveBeenCalled();
  });

  it('leaves a name flagged as adult text off the post', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(arena({ textNsfw: true }));

    await create();

    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({ title: undefined }));
  });
});

describe('submitEntry — who and what may enter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
  });

  it("refuses the crucible's own creator", async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      userId: 42,
    });

    await expect(submit()).rejects.toThrow(/can't enter a crucible you created/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('refuses media created before the crucible started', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ...imageRow(MediaType.image),
      createdAt: new Date(CRUCIBLE_STARTED_AT.getTime() - 1),
    });

    await expect(submit()).rejects.toThrow(/created after this crucible started/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('falls back to the creation time for a crucible with no recorded start', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      startAt: null,
    });
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      ...imageRow(MediaType.image),
      createdAt: new Date(CRUCIBLE_STARTED_AT.getTime() - 1),
    });

    await expect(submit()).rejects.toThrow(/created after this crucible started/);
  });

  it('refuses an image that does not use a required model', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      allowedResources: [500],
    });
    fetchImageResources.mockResolvedValue({ 7: { resources: [{ modelVersionId: 600 }] } });

    await expect(submit()).rejects.toThrow(/does not use any of the required resources/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it('accepts an image that uses a required model', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.image),
      allowedResources: [500],
    });
    fetchImageResources.mockResolvedValue({ 7: { resources: [{ modelVersionId: 500 }] } });

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });
});

describe('checkCrucibleEntryEligibility', () => {
  const check = (imageIds: number[]) =>
    checkCrucibleEntryEligibility({ crucibleId: 1, imageIds, userId: 42 });
  const after = new Date(CRUCIBLE_STARTED_AT.getTime() + 60_000);
  const before = new Date(CRUCIBLE_STARTED_AT.getTime() - 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      startAt: CRUCIBLE_STARTED_AT,
      createdAt: CRUCIBLE_STARTED_AT,
      allowedResources: [500],
      allowedBaseModels: [],
    });
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { id: 1, createdAt: after },
      { id: 2, createdAt: before },
      { id: 3, createdAt: after },
      { id: 4, createdAt: after },
    ]);
    fetchImageResources.mockResolvedValue({
      1: { resources: [{ modelVersionId: 500 }] },
      2: { resources: [{ modelVersionId: 500 }] },
      3: { resources: [{ modelVersionId: 600 }] },
    });
  });

  it('answers each image with the reasons submission would refuse it for', async () => {
    await expect(check([1, 2, 3, 4])).resolves.toEqual([
      { imageId: 1, eligible: true, reasons: [] },
      { imageId: 2, eligible: false, reasons: ['created-before-start'] },
      { imageId: 3, eligible: false, reasons: ['missing-required-resource'] },
      { imageId: 4, eligible: false, reasons: ['no-resources'] },
    ]);
  });

  describe('once a required model is held to PG and PG-13', () => {
    const withRequiredModel = (flagged: boolean) => {
      dbMock.dbRead.image.findMany.mockResolvedValue([
        { id: 1, createdAt: after, nsfwLevel: 1 },
        { id: 5, createdAt: after, nsfwLevel: 4 },
      ]);
      fetchImageResources.mockResolvedValue({
        1: { resources: [{ modelVersionId: 500 }] },
        5: { resources: [{ modelVersionId: 500 }] },
      });
      dbMock.dbRead.modelVersion.findMany.mockImplementation(
        modelFlagsFindMany((id) => (id === 500 ? { minor: false, sfwOnly: flagged } : undefined))
      );
    };

    it('refuses the mature images and keeps the PG ones', async () => {
      withRequiredModel(true);

      await expect(check([1, 5])).resolves.toEqual([
        { imageId: 1, eligible: true, reasons: [] },
        { imageId: 5, eligible: false, reasons: ['required-model-level'] },
      ]);
    });

    it('leaves mature images alone while no required model is held there', async () => {
      withRequiredModel(false);

      await expect(check([5])).resolves.toEqual([{ imageId: 5, eligible: true, reasons: [] }]);
    });
  });

  it("only looks at the caller's own images", async () => {
    await check([1]);

    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: [1] }, userId: 42 },
        select: expect.objectContaining({ nsfwLevel: true }),
      })
    );
  });

  it('marks an image it could not find as ineligible rather than eligible', async () => {
    await expect(check([99])).resolves.toEqual([
      { imageId: 99, eligible: false, reasons: ['not-found'] },
    ]);
  });

  it('skips the resource lookup when the crucible requires no model', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      startAt: CRUCIBLE_STARTED_AT,
      createdAt: CRUCIBLE_STARTED_AT,
      allowedResources: null,
      allowedBaseModels: [],
    });

    await expect(check([3])).resolves.toEqual([{ imageId: 3, eligible: true, reasons: [] }]);
    expect(fetchImageResources).not.toHaveBeenCalled();
  });
});

describe('submitEntry — base model requirements', () => {
  const H3_API = 3183239;
  const H3_COMFY = 3216500;
  const resource = (modelVersionId: number, modelType: string, baseModel: string) => ({
    modelVersionId,
    modelType,
    baseModel,
  });
  const h3FineTune = resource(9001, 'Checkpoint', 'MiniMax H3');
  const requiring = (overrides: { allowedResources?: number[]; allowedBaseModels?: string[] }) =>
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      ...crucibleRow(MediaType.video),
      ...overrides,
    });
  const madeWith = (...resources: ReturnType<typeof resource>[]) =>
    fetchImageResources.mockResolvedValue({ 7: { resources } });

  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.video));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
  });

  it('accepts an entry made with a fine-tuned checkpoint of an allowed base model', async () => {
    requiring({ allowedBaseModels: ['MiniMax H3'] });
    madeWith(h3FineTune);

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('refuses an entry made with a checkpoint of another base model', async () => {
    requiring({ allowedBaseModels: ['MiniMax H3'] });
    madeWith(resource(9002, 'Checkpoint', 'Wan Video 2.2 T2V-A14B'));

    await expect(submit()).rejects.toThrow(/allowed base models/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  it("refuses an allowed base model's LoRA on another base model's checkpoint", async () => {
    requiring({ allowedBaseModels: ['MiniMax H3'] });
    madeWith(
      resource(9002, 'Checkpoint', 'Wan Video 2.2 T2V-A14B'),
      resource(9003, 'LORA', 'MiniMax H3')
    );

    await expect(submit()).rejects.toThrow(/allowed base models/);
  });

  it('accepts an allowed checkpoint alongside resources of other base models', async () => {
    requiring({ allowedBaseModels: ['MiniMax H3'] });
    madeWith(
      resource(9002, 'Checkpoint', 'Wan Video 2.2 T2V-A14B'),
      h3FineTune,
      resource(9003, 'LORA', 'SDXL 1.0')
    );

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('refuses an entry with no detected resources', async () => {
    requiring({ allowedBaseModels: ['MiniMax H3'] });
    madeWith();

    await expect(submit()).rejects.toThrow(/no detected resources/);
  });

  it('a version list still refuses a fine-tune of the same base model, exactly as before', async () => {
    requiring({ allowedResources: [H3_API, H3_COMFY] });
    madeWith(h3FineTune);

    await expect(submit()).rejects.toThrow(/does not use any of the required resources/);
  });

  it('a version list still accepts a listed version, exactly as before', async () => {
    requiring({ allowedResources: [H3_API, H3_COMFY] });
    madeWith(resource(H3_COMFY, 'Checkpoint', 'MiniMax H3'));

    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });

  it('requires both when a crucible sets a version list and base models', async () => {
    requiring({ allowedResources: [H3_API], allowedBaseModels: ['MiniMax H3'] });
    madeWith(h3FineTune);
    await expect(submit()).rejects.toThrow(/does not use any of the required resources/);

    madeWith(resource(9002, 'Checkpoint', 'SDXL 1.0'), resource(H3_API, 'LORA', 'SDXL 1.0'));
    await expect(submit()).rejects.toThrow(/allowed base models/);

    madeWith(resource(H3_API, 'Checkpoint', 'MiniMax H3'));
    await expect(submit()).resolves.toMatchObject({ id: 5 });
  });
});

describe('checkCrucibleEntryEligibility — base model requirements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      startAt: CRUCIBLE_STARTED_AT,
      createdAt: CRUCIBLE_STARTED_AT,
      allowedResources: null,
      allowedBaseModels: ['MiniMax H3'],
    });
    const after = new Date(CRUCIBLE_STARTED_AT.getTime() + 60_000);
    dbMock.dbRead.image.findMany.mockResolvedValue([
      { id: 1, createdAt: after },
      { id: 2, createdAt: after },
    ]);
    fetchImageResources.mockResolvedValue({
      1: {
        resources: [{ modelVersionId: 9001, modelType: 'Checkpoint', baseModel: 'MiniMax H3' }],
      },
      2: { resources: [{ modelVersionId: 9002, modelType: 'Checkpoint', baseModel: 'SDXL 1.0' }] },
    });
  });

  it('tells the submit modal which images were made with the wrong base model', async () => {
    await expect(
      checkCrucibleEntryEligibility({ crucibleId: 1, imageIds: [1, 2], userId: 42 })
    ).resolves.toEqual([
      { imageId: 1, eligible: true, reasons: [] },
      { imageId: 2, eligible: false, reasons: ['wrong-base-model'] },
    ]);
  });
});

describe('createCrucibleInputSchema — base models', () => {
  const parse = (allowedBaseModels: string[]) =>
    createCrucibleInputSchema.safeParse({ ...validCreateInput, allowedBaseModels });

  it('accepts a known base model and drops repeats', () => {
    const result = parse(['MiniMax H3', 'MiniMax H3']);
    expect(result.success && result.data.allowedBaseModels).toEqual(['MiniMax H3']);
  });

  it('refuses a name that is not a base model, on create and on edit', () => {
    expect(parse(['MiniMax H4']).success).toBe(false);
    expect(
      updateCrucibleSchema.safeParse({ id: 1, allowedBaseModels: ['MiniMax H4'] }).success
    ).toBe(false);
    expect(
      updateCrucibleSchema.safeParse({ id: 1, allowedBaseModels: ['MiniMax H3'] }).success
    ).toBe(true);
  });

  it('caps how many base models a crucible can require', () => {
    const names = baseModelRecords
      .slice(0, CRUCIBLE_MAX_ALLOWED_BASE_MODELS + 1)
      .map((m) => m.name);
    expect(parse(names.slice(0, CRUCIBLE_MAX_ALLOWED_BASE_MODELS)).success).toBe(true);
    expect(parse(names).success).toBe(false);
  });
});

describe('createCrucibleInputSchema — late entries', () => {
  it('defaults to warning in the last 20% and closing entries in the last 10%', () => {
    const result = createCrucibleInputSchema.parse(validCreateInput);
    expect([result.entryWarningPercent, result.entryCutoffPercent]).toEqual([20, 10]);
  });

  it('accepts entries open to the very end', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, entryCutoffPercent: 0 }).success
    ).toBe(true);
  });

  it.each([
    [20, 20],
    [15, 30],
  ])(
    'refuses a %s%% warning with entries closing at %s%%',
    (entryWarningPercent, entryCutoffPercent) => {
      const result = createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        entryWarningPercent,
        entryCutoffPercent,
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['entryCutoffPercent']);
    }
  );

  // Each pairs the value under test with a partner that satisfies cutoff < warning, so only the
  // range can refuse it.
  it.each([
    [
      'warning below its minimum',
      { entryWarningPercent: 9, entryCutoffPercent: 0 },
      'entryWarningPercent',
    ],
    [
      'warning above its maximum',
      { entryWarningPercent: 51, entryCutoffPercent: 10 },
      'entryWarningPercent',
    ],
    [
      'cutoff above its maximum',
      { entryWarningPercent: 50, entryCutoffPercent: 41 },
      'entryCutoffPercent',
    ],
    ['negative cutoff', { entryWarningPercent: 20, entryCutoffPercent: -1 }, 'entryCutoffPercent'],
  ])('refuses a %s', (_, overrides, field) => {
    const result = createCrucibleInputSchema.safeParse({ ...validCreateInput, ...overrides });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([[field]]);
  });

  it.each([
    { entryWarningPercent: 10, entryCutoffPercent: 0 },
    { entryWarningPercent: 50, entryCutoffPercent: 40 },
  ])('accepts the edges of both ranges: %o', (overrides) => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, ...overrides }).success).toBe(
      true
    );
  });
});

describe('submitEntry — entries close before the end', () => {
  const HOUR = 60 * 60_000;
  // A 10h run with 1h left: the last 10% of it.
  const lastTenth = (entryCutoffPercent: number) => ({
    ...crucibleRow(MediaType.image),
    startAt: new Date(Date.now() - 9 * HOUR),
    endAt: new Date(Date.now() + HOUR),
    entryCutoffPercent,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbRead.image.count.mockResolvedValue(1);
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({ id: 5, user: { username: 'tester' } });
  });

  it('refuses an entry once the crucible is inside its closing share', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(lastTenth(20));

    await expect(submit()).rejects.toThrow(CRUCIBLE_ENTRIES_CLOSED_MESSAGE);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
  });

  // The mocks hand back whatever the fixture holds, so only this sees a select that stopped asking
  // for the window: entries would then stay open to the end.
  it('reads the window it gates on', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(lastTenth(0));
    await submit();
    expect(dbMock.dbRead.crucible.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ startAt: true, endAt: true, entryCutoffPercent: true }),
      })
    );

    vi.mocked(dbMock.dbRead.crucible.findUnique).mockClear();
    createPost.mockResolvedValue({ id: 900 });
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({ ...lastTenth(0), name: 'Open Arena' });
    await createCrucibleEntryPost({ crucibleId: 1, userId: 42 });
    expect(dbMock.dbRead.crucible.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ startAt: true, endAt: true, entryCutoffPercent: true }),
      })
    );
  });

  it.each([0, 5])(
    'accepts an entry with a %s%% cutoff and 10%% of the run left',
    async (cutoff) => {
      dbMock.dbRead.crucible.findUnique.mockResolvedValue(lastTenth(cutoff));

      await expect(submit()).resolves.toMatchObject({ id: 5 });
    }
  );

  it('refuses to start an entry upload once entries are closed', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({ ...lastTenth(20), name: 'Open Arena' });
    createPost.mockResolvedValue({ id: 900 });

    await expect(createCrucibleEntryPost({ crucibleId: 1, userId: 42 })).rejects.toThrow(
      CRUCIBLE_ENTRIES_CLOSED_MESSAGE
    );
    expect(createPost).not.toHaveBeenCalled();
  });
});

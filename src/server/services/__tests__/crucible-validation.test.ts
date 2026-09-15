import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateCrucibleSetupCost,
  cancelCrucibleSchema,
  createCrucibleInputSchema,
  crucibleImageSchema,
  getCruciblesInfiniteSchema,
  getJudgingPairSchema,
  submitEntrySchema,
  submitVoteSchema,
} from '~/server/schema/crucible.schema';
import { CrucibleSort } from '~/server/common/enums';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks';
import type * as NotificationService from '~/server/services/notification.service';
import {
  CRUCIBLE_DURATION_COSTS,
  CRUCIBLE_MAX_CLIP_SECONDS,
  CRUCIBLE_MAX_ENTRIES,
  CRUCIBLE_MAX_ENTRY_FEE,
  CRUCIBLE_MAX_MIN_VIEW_SECONDS,
  CRUCIBLE_MAX_SEEDED_PRIZE_POOL,
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
} from '~/shared/constants/crucible.constants';

const createNotification = vi.fn();

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const { submitEntry } = await import('~/server/services/crucible.service');

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
  duration: 8,
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

  it('rejects an empty name', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, name: '   ' }).success).toBe(
      false
    );
  });

  it('rejects a missing description', () => {
    expect(
      createCrucibleInputSchema.safeParse({ ...validCreateInput, description: '' }).success
    ).toBe(false);
  });

  it('rejects a negative entry fee', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, entryFee: -1 }).success).toBe(
      false
    );
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

  it('rejects prize percentages summing above 100', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 60, '2': 50 },
      }).success
    ).toBe(false);
  });

  it('accepts prize percentages summing to exactly 100, and below it', () => {
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 100 },
      }).success
    ).toBe(true);
    expect(
      createCrucibleInputSchema.safeParse({
        ...validCreateInput,
        prizePositions: { '1': 40, '2': 20 },
      }).success
    ).toBe(true);
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

  it('defaults prizeCustomized to false', () => {
    const parsed = createCrucibleInputSchema.parse(validCreateInput);
    expect(parsed.prizeCustomized).toBe(false);
  });

  it('rejects a duration below one hour', () => {
    expect(createCrucibleInputSchema.safeParse({ ...validCreateInput, duration: 0 }).success).toBe(
      false
    );
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
    expect(calculateCrucibleSetupCost(24, true)).toBe(
      CRUCIBLE_DURATION_COSTS[24] + CRUCIBLE_PRIZE_CUSTOMIZATION_COST
    );
  });

  it('charges only the customization fee when the duration itself is free', () => {
    expect(CRUCIBLE_DURATION_COSTS[8]).toBe(0);
    expect(calculateCrucibleSetupCost(8, true)).toBe(CRUCIBLE_PRIZE_CUSTOMIZATION_COST);
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

const crucibleRow = (contentType: MediaType, maxClipSeconds: number | null = null) => ({
  id: 1,
  name: 'Test Crucible',
  userId: 99,
  status: CrucibleStatus.Active,
  nsfwLevel: 1,
  contentType,
  entryFee: 0,
  entryLimit: 1,
  maxTotalEntries: null,
  minViewSeconds: null,
  maxClipSeconds,
  allowedResources: null,
  endAt: new Date(Date.now() + 60_000),
  _count: { entries: 0 },
});

const imageRow = (type: MediaType, metadata: Record<string, unknown> | null = null) => ({
  id: 7,
  userId: 42,
  type,
  nsfwLevel: 1,
  metadata,
});

const submit = () => submitEntry({ crucibleId: 1, imageId: 7, userId: 42 });

describe('submitEntry — content type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.image));
    dbMock.dbRead.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(imageRow(MediaType.image));
    dbMock.dbWrite.crucibleEntry.create.mockResolvedValue({
      id: 5,
      user: { username: 'tester' },
    });
  });

  it('accepts an image in an image crucible — the pre-video behaviour', async () => {
    await expect(submit()).resolves.toMatchObject({ id: 5 });
    expect(dbMock.dbWrite.crucibleEntry.create).toHaveBeenCalledTimes(1);
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
    ['a minimum past the ceiling', { minViewSeconds: CRUCIBLE_MAX_MIN_VIEW_SECONDS + 1 }],
    ['a maximum past the ceiling', { maxClipSeconds: CRUCIBLE_MAX_CLIP_SECONDS + 1 }],
  ])('rejects %s', (_label, settings) => {
    expect(createCrucibleInputSchema.safeParse({ ...videoInput, ...settings }).success).toBe(false);
  });
});

describe('submitEntry — maximum clip length', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNotification.mockResolvedValue(undefined);
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow(MediaType.video, 120));
    dbMock.dbRead.crucibleEntry.count.mockResolvedValue(0);
    dbMock.dbRead.crucibleEntry.findFirst.mockResolvedValue(null);
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      imageRow(MediaType.video, { duration: 6.592 })
    );
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

    await expect(submit()).rejects.toThrow(/2:00/);
    expect(dbMock.dbWrite.crucibleEntry.create).not.toHaveBeenCalled();
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

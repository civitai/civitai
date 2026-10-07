import { beforeEach, describe, expect, it, vi } from 'vitest';
import { modelFlagsFindMany } from '~/server/services/__tests__/fixtures/model-flags-find-many';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
  MediaType,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import {
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
} from '~/shared/constants/crucible.constants';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as CrucibleEligibilityService from '~/server/services/crucible-eligibility.service';
import type * as CoverImageService from '~/server/services/cover-image.service';
import type * as TextModerationService from '~/server/services/text-moderation.service';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { dbMock, loggingMock } from '~/__tests__/mocks';
import { CrucibleSort } from '~/server/common/enums';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const crucibleCreate = dbMock.dbWrite.crucible.create;
const crucibleUpdate = dbMock.dbWrite.crucible.update;
const crucibleDelete = dbMock.dbWrite.crucible.delete;
const crucibleUpdateMany = dbMock.dbWrite.crucible.updateMany;
const modelVersionCount = dbMock.dbRead.modelVersion.count;
const modelVersionFindMany = dbMock.dbRead.modelVersion.findMany;
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const assertCanCreateCrucible = vi.fn();
const throwOnBlockedUserContent = vi.fn();
const resolveCoverImageId = vi.fn();
const submitTextModeration = vi.fn();

vi.mock('~/server/services/text-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TextModerationService>()),
  submitTextModeration,
}));

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(async () => 'off'),
}));

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));

vi.mock('~/server/services/crucible-eligibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEligibilityService>()),
  assertCanCreateCrucible,
}));

vi.mock('~/server/services/cover-image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverImageService>()),
  resolveCoverImageId,
}));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));

const { activateScheduledCrucibles, createCrucible, getCrucibles } = await import(
  '~/server/services/crucible.service'
);

// 24 hours is free and the split below is custom, so the customization fee is the whole setup cost.
const SETUP_FEE = CRUCIBLE_PRIZE_CUSTOMIZATION_COST;

const input = (overrides: Record<string, unknown> = {}) => ({
  userId: 4,
  name: 'Test Crucible',
  description: 'A description',
  coverImage: { url: '6a1c3f3d-29e5-49c1-816f-bfc0f7c5c900', width: 512, height: 704 },
  nsfwLevel: 1,
  entryFee: 100,
  entryLimit: 1,
  maxTotalEntries: undefined,
  prizePositions: { '1': 70, '2': 30 },
  duration: 24,
  seededPrizePool: 0,
  ...overrides,
});

const balance = (amount: number) =>
  getUserBuzzAccount.mockResolvedValue([{ balance: amount, type: 'yellow' }]);

const storedData = () => ({
  ...crucibleCreate.mock.calls[0][0].data,
  ...(crucibleUpdate.mock.calls[0]?.[0].data ?? {}),
});

const chargedAmounts = () =>
  createMultiAccountBuzzTransaction.mock.calls.map(([arg]) => arg.amount);

/** Every id the service asks about counts as a published, public model version. */
const allPublished = async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.length;

const refundedPrefixes = () =>
  refundMultiAccountTransaction.mock.calls.map(([arg]) => arg.externalTransactionIdPrefix);

beforeEach(() => {
  vi.clearAllMocks();
  balance(1_000_000);
  modelVersionCount.mockImplementation(allPublished);
  modelVersionFindMany.mockResolvedValue([]);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactions: [] });
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  assertCanCreateCrucible.mockResolvedValue(undefined);
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  resolveCoverImageId.mockResolvedValue(99);
  crucibleCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    ...data,
  }));
  crucibleUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    ...data,
  }));
  crucibleDelete.mockResolvedValue({ id: 1 });
});

describe('createCrucible — cover image', () => {
  it('stores the cover from the scanned upload path, not a row rated by the allowed levels', async () => {
    await createCrucible(input({ nsfwLevel: 31 }));

    expect(resolveCoverImageId).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 4,
        coverImage: expect.not.objectContaining({ nsfwLevel: expect.anything() }),
      })
    );
    expect(dbMock.dbWrite.image.create).not.toHaveBeenCalled();
    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data).toMatchObject({ imageId: 99, nsfwLevel: 31 });
  });

  it('resolves the cover before any Buzz moves', async () => {
    resolveCoverImageId.mockRejectedValue(new Error('This cover image is no longer available.'));

    await expect(createCrucible(input())).rejects.toThrow('no longer available');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });
});

describe('createCrucible — seeded prize pool', () => {
  it('charges the seed as its own transaction on top of the setup fee', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    expect(chargedAmounts()).toEqual([SETUP_FEE, 5_000]);
  });

  it('stores the seed and the prefix that can refund it', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    const data = storedData();
    expect(data.seededPrizePool).toBe(5_000);
    expect(data.prizePool).toBe(5_000);
    expect(data.seedTransactionId).toMatch(/^crucible-seed-4-/);
    expect(data.seedTransactionId).not.toBe(data.buzzTransactionId);
  });

  it('stores no seed prefix when nothing was seeded', async () => {
    await createCrucible(input({ seededPrizePool: 0 }));

    const data = storedData();
    expect(data.seededPrizePool).toBe(0);
    expect(data.seedTransactionId).toBeNull();
    expect(chargedAmounts()).toEqual([SETUP_FEE]);
  });
});

describe('createCrucible — the creator cannot afford the seed', () => {
  it('fails and creates no crucible', async () => {
    balance(4_000); // covers the setup fee but not the 5,000 seed

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow();

    expect(crucibleCreate).not.toHaveBeenCalled();
  });

  it('takes no money at all, rather than charging the setup fee first and unwinding it', async () => {
    balance(4_000);

    await createCrucible(input({ seededPrizePool: 5_000 })).catch(() => undefined);

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('names the combined cost in the error, not just the setup fee', async () => {
    balance(4_000);

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow(
      new RegExp(`${(SETUP_FEE + 5_000).toLocaleString()} yellow Buzz`)
    );
  });
});

describe('createCrucible — the row is written before any Buzz moves', () => {
  it('inserts it as upcoming, then records the payment and opens it', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    expect(crucibleCreate.mock.calls[0][0].data.status).toBe(CrucibleStatus.Pending);
    // No start until paid, so activateScheduledCrucibles can't open it mid-charge.
    expect(crucibleCreate.mock.calls[0][0].data.startAt).toBeNull();
    expect(crucibleCreate.mock.invocationCallOrder[0]).toBeLessThan(
      createMultiAccountBuzzTransaction.mock.invocationCallOrder[0]
    );
    expect(crucibleUpdate.mock.calls[0][0].data).toMatchObject({
      status: CrucibleStatus.Active,
      buzzTransactionId: expect.stringMatching(/^crucible-setup-4-/),
      seedTransactionId: expect.stringMatching(/^crucible-seed-4-/),
    });
  });

  it('takes no money when the insert fails', async () => {
    crucibleCreate.mockRejectedValue(new Error('db down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('refunds the setup fee and deletes the unpaid crucible when the seed charge fails', async () => {
    createMultiAccountBuzzTransaction.mockImplementation(async ({ amount }: { amount: number }) => {
      if (amount === 5_000) throw new Error('buzz down');
      return { transactions: [] };
    });

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('buzz down');

    expect(refundedPrefixes()).toEqual([expect.stringMatching(/^crucible-setup-4-/)]);
    expect(crucibleDelete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(crucibleUpdate).not.toHaveBeenCalled();
  });

  it('refunds both charges and deletes the crucible when recording the payment fails', async () => {
    crucibleUpdate.mockRejectedValue(new Error('db down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');

    expect(refundedPrefixes()).toEqual([
      expect.stringMatching(/^crucible-setup-4-/),
      expect.stringMatching(/^crucible-seed-4-/),
    ]);
    expect(crucibleDelete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('still surfaces the original failure when the refund itself fails, and logs the refund', async () => {
    crucibleUpdate.mockRejectedValue(new Error('db down'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('refund down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-charge-refund-failed',
        prefix: expect.stringMatching(/^crucible-setup-4-/),
        entityId: 1,
      })
    );
  });

  it('logs an unpaid crucible it could not delete', async () => {
    createMultiAccountBuzzTransaction.mockRejectedValue(new Error('buzz down'));
    crucibleDelete.mockRejectedValue(new Error('db down'));

    await expect(createCrucible(input())).rejects.toThrow('buzz down');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-unpaid-delete-failed',
        crucibleId: 1,
      })
    );
  });
});

describe('createCrucible — Buzz type', () => {
  it("charges and checks the balance in the crucible's own currency only", async () => {
    await createCrucible(input({ buzzType: 'green', seededPrizePool: 5_000 }));

    expect(getUserBuzzAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountTypes: ['green'] })
    );
    for (const [charge] of createMultiAccountBuzzTransaction.mock.calls)
      expect(charge.fromAccountTypes).toEqual(['green']);
    expect(storedData().buzzType).toBe('green');
  });

  it('refuses a green crucible that allows mature content, before any money moves', async () => {
    await expect(createCrucible(input({ buzzType: 'green', nsfwLevel: 1 | 4 }))).rejects.toThrow(
      /green Buzz crucible/
    );
    expect(crucibleCreate).not.toHaveBeenCalled();
  });
});

describe('createCrucible — video settings', () => {
  const videoInput = (overrides: Record<string, unknown> = {}) =>
    input({ contentType: MediaType.video, ...overrides });

  it('stores both settings on a video crucible', async () => {
    await createCrucible(videoInput({ minViewSeconds: 6, maxClipSeconds: 120 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    // Asserted separately rather than as one object, so a swap of the two fails on the value
    // rather than passing an "each is a number" shape check.
    expect(data.minViewSeconds).toBe(6);
    expect(data.maxClipSeconds).toBe(120);
  });

  it('stores null for a setting the creator left blank', async () => {
    await createCrucible(videoInput({ minViewSeconds: 6 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.minViewSeconds).toBe(6);
    expect(data.maxClipSeconds).toBeNull();
  });

  it('writes null on an IMAGE crucible even when the client sends values', async () => {
    // Crucible_video_settings_require_video rejects anything else, so passing these through would
    // turn a stale client payload into a constraint violation at insert time.
    await createCrucible(input({ minViewSeconds: 6, maxClipSeconds: 120 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.minViewSeconds).toBeNull();
    expect(data.maxClipSeconds).toBeNull();
  });

  it('writes null, never undefined, when nothing was set', async () => {
    // `undefined` would leave Prisma to apply a column default; these columns have none, and the
    // distinction is invisible in a mock that only checks falsiness.
    await createCrucible(videoInput());

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.minViewSeconds).toBeNull();
    expect(data.maxClipSeconds).toBeNull();
  });
});

describe('createCrucible — start date', () => {
  const HOUR = 60 * 60 * 1000;

  it('schedules a future start as Pending, ending one duration after it starts', async () => {
    const startAt = new Date(Date.now() + 48 * HOUR);

    await createCrucible(input({ startAt, duration: 24 }));

    const data = storedData();
    expect(data.status).toBe(CrucibleStatus.Pending);
    expect(data.startAt).toEqual(startAt);
    expect(data.endAt).toEqual(new Date(startAt.getTime() + 24 * HOUR));
  });

  it('starts immediately when the chosen start already passed', async () => {
    const before = Date.now();

    await createCrucible(input({ startAt: new Date(before - HOUR) }));

    const data = storedData();
    expect(data.status).toBe(CrucibleStatus.Active);
    expect((data.startAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('starts immediately when no start was given', async () => {
    await createCrucible(input());

    const data = storedData();
    expect(data.status).toBe(CrucibleStatus.Active);
  });
});

describe('createCrucible — resource requirements', () => {
  it('charges the requirements fee on top of the setup fee', async () => {
    await createCrucible(input({ allowedResources: [123] }));

    expect(chargedAmounts()).toEqual([SETUP_FEE + CRUCIBLE_RESOURCE_REQUIREMENTS_COST]);
  });

  it('charges nothing extra, and stores no restriction, for an empty list', async () => {
    await createCrucible(input({ allowedResources: [] }));

    expect(chargedAmounts()).toEqual([SETUP_FEE]);
    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.allowedResources).not.toEqual([]);
  });

  it('refuses a model that is not published and public, before anything is written or charged', async () => {
    modelVersionCount.mockResolvedValue(0);

    await expect(createCrucible(input({ allowedResources: [123] }))).rejects.toThrow(
      /published, public model/
    );
    expect(modelVersionCount).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: { in: [123] }, status: ModelStatus.Published }),
    });
    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('refuses a required model that makes the other media type, before anything is written', async () => {
    modelVersionFindMany.mockResolvedValue([
      { baseModel: 'SDXL 1.0' },
      { baseModel: 'MiniMax H3' },
    ]);

    await expect(createCrucible(input({ allowedResources: [123, 124] }))).rejects.toThrow(
      /must make images/
    );
    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('accepts a model that makes both images and videos', async () => {
    modelVersionFindMany.mockResolvedValue([{ baseModel: 'Grok' }]);

    await createCrucible(input({ allowedResources: [123] }));

    expect(crucibleCreate).toHaveBeenCalled();
  });
});

describe('createCrucible — base model requirements', () => {
  it('stores the base models without charging the resource requirements fee', async () => {
    await createCrucible(input({ allowedBaseModels: ['SDXL 1.0'] }));

    expect(chargedAmounts()).toEqual([SETUP_FEE]);
    expect(storedData().allowedBaseModels).toEqual(['SDXL 1.0']);
  });

  it('charges the fee once when versions are required too', async () => {
    await createCrucible(input({ allowedResources: [123], allowedBaseModels: ['SDXL 1.0'] }));

    expect(chargedAmounts()).toEqual([SETUP_FEE + CRUCIBLE_RESOURCE_REQUIREMENTS_COST]);
  });

  it('refuses a base model that makes the other media type, before anything is written', async () => {
    await expect(createCrucible(input({ allowedBaseModels: ['MiniMax H3'] }))).rejects.toThrow(
      /allowed base model must make images/
    );
    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });
});

describe('createCrucible — required models unsuitable for mature content', () => {
  const R = 1 | 2 | 4;
  const PG13 = 1 | 2;
  /** Version 123 + i carries models[i]; the media-type check's query gets []. */
  const withModels = (...models: { minor: boolean; sfwOnly: boolean }[]) =>
    modelVersionFindMany.mockImplementation(modelFlagsFindMany((id) => models[id - 123]));

  it.each([
    ['minor', { minor: true, sfwOnly: false }],
    ['SFW-only', { minor: false, sfwOnly: true }],
  ])('refuses R+ when a required model is %s, before anything is written', async (_, flags) => {
    withModels({ minor: false, sfwOnly: false }, flags);

    await expect(
      createCrucible(input({ nsfwLevel: R, allowedResources: [123, 124] }))
    ).rejects.toThrow(/PG and PG-13/);
    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('allows PG-13 with such a model', async () => {
    withModels({ minor: true, sfwOnly: true });

    await createCrucible(input({ nsfwLevel: PG13, allowedResources: [123] }));

    expect(crucibleCreate).toHaveBeenCalled();
  });

  it('allows R+ when no required model is flagged', async () => {
    withModels({ minor: false, sfwOnly: false });

    await createCrucible(input({ nsfwLevel: R, allowedResources: [123] }));

    expect(crucibleCreate).toHaveBeenCalled();
  });
});

describe('activateScheduledCrucibles', () => {
  it('opens only Pending crucibles whose start has passed', async () => {
    crucibleUpdateMany.mockResolvedValue({ count: 2 });

    await expect(activateScheduledCrucibles()).resolves.toBe(2);

    const [{ where, data }] = crucibleUpdateMany.mock.calls[0];
    expect(where.status).toBe(CrucibleStatus.Pending);
    expect(where.startAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
    expect(data).toEqual({ status: CrucibleStatus.Active });
  });

  it('keeps one whose text or cover has not passed its scan closed', async () => {
    crucibleUpdateMany.mockResolvedValue({ count: 0 });

    await activateScheduledCrucibles();

    const { where } = crucibleUpdateMany.mock.calls[0][0];
    expect(where.ingestion).toBe(CrucibleIngestionStatus.Scanned);
    expect(where.image).toEqual({ ingestion: ImageIngestionStatus.Scanned });
  });
});

describe('createCrucible — text scan', () => {
  beforeEach(() => {
    submitTextModeration.mockResolvedValue(undefined);
    dbMock.dbWrite.crucible.findUnique.mockResolvedValue({
      name: 'Test Crucible',
      description: 'A description',
    });
  });

  it('starts it under review and queues the name and description once it is open', async () => {
    await createCrucible(input());

    expect(crucibleCreate.mock.calls[0][0].data.ingestion).toBe(CrucibleIngestionStatus.Pending);
    expect(submitTextModeration).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'Crucible',
        entityId: 1,
        content: 'Test Crucible\nA description',
      })
    );
    expect(submitTextModeration.mock.invocationCallOrder[0]).toBeGreaterThan(
      crucibleUpdate.mock.invocationCallOrder[0]
    );
  });

  it('queues nothing when the charge fails and the row is removed', async () => {
    createMultiAccountBuzzTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(createCrucible(input())).rejects.toThrow();
    expect(submitTextModeration).not.toHaveBeenCalled();
  });

  it('still creates it when the scan cannot be queued', async () => {
    submitTextModeration.mockRejectedValue(new Error('orchestrator down'));

    await expect(createCrucible(input())).resolves.toBeTruthy();
  });
});

/**
 * The feed runs one query per status segment, running crucibles first. Reading only one of them
 * would leave the other free to drop the visibility filters, so every query must carry the same
 * `where` apart from its status. Snapshotted per call: the segments share nested objects, so a
 * recorded argument shows only their final state.
 */
const sharedFeedWhere = async (run: () => Promise<unknown>, queries = 2) => {
  const wheres: Record<string, unknown>[] = [];
  dbMock.dbRead.crucible.findMany.mockImplementation((async ({ where }: { where: object }) => {
    wheres.push({ ...structuredClone(where), status: undefined });
    return [];
  }) as never);
  await run();
  dbMock.dbRead.crucible.findMany.mockReset();
  expect(wheres).toHaveLength(queries);
  for (const where of wheres) expect(where).toEqual(wheres[0]);
  return wheres[0] as any;
};

describe('getCrucibles — browsing level', () => {
  const findMany = dbMock.dbRead.crucible.findMany;
  const whereFor = async (opts: {
    browsingLevel?: number;
    viewerId?: number;
    isGreen?: boolean;
  }) => {
    findMany.mockResolvedValue([]);
    return sharedFeedWhere(() =>
      getCrucibles({
        input: { limit: 10, sort: CrucibleSort.Newest, browsingLevel: opts.browsingLevel },
        select: { id: true },
        viewerId: opts.viewerId,
        isGreen: opts.isGreen,
      })
    );
  };

  it('keeps every filter on a later page, which starts partway through the groups', async () => {
    const feed = (cursor?: number) =>
      getCrucibles({
        input: { limit: 10, sort: CrucibleSort.Newest, browsingLevel: 1, cursor },
        select: { id: true },
        viewerId: 4,
        isGreen: true,
        excludedUserIds: [7],
      });
    const firstPage = await sharedFeedWhere(() => feed());
    dbMock.dbRead.crucible.findUnique.mockResolvedValueOnce({
      status: CrucibleStatus.Pending,
    } as never);

    expect(await sharedFeedWhere(() => feed(5), 1)).toEqual(firstPage);
  });

  it('requires both the crucible and its cover to fall inside the level', async () => {
    const where = await whereFor({ browsingLevel: 1 });
    const levels = where.AND[0].AND[1];
    expect(levels.nsfwLevel.in).toContain(31);
    expect(levels.nsfwLevel.in).not.toContain(4);
    expect(levels.image.nsfwLevel.in).toEqual(levels.nsfwLevel.in);
  });

  it('lists only crucibles whose text and cover passed their scans, level or not', async () => {
    for (const browsingLevel of [undefined, 1]) {
      const where = await whereFor({ browsingLevel });
      expect(where.AND[0].AND[0]).toEqual({
        ingestion: CrucibleIngestionStatus.Scanned,
        image: { ingestion: ImageIngestionStatus.Scanned },
      });
    }
  });

  it('hides adult text from a viewer who browses no R or above', async () => {
    expect((await whereFor({ browsingLevel: 3 })).AND[0].AND).toContainEqual({ textNsfw: false });
    expect((await whereFor({ browsingLevel: 31 })).AND[0].AND).not.toContainEqual({
      textNsfw: false,
    });
  });

  it('always shows the viewer their own crucibles', async () => {
    const where = await whereFor({ browsingLevel: 1, viewerId: 4 });
    expect(where.AND[0].OR[0]).toEqual({ userId: 4 });
  });

  // A crucible takes entry fees in either currency, so what it was created in must not decide where
  // it is listed: every crucible was yellow at launch, and the green site listed none of them.
  it('lists on both sites whatever currency the creator paid in, SFW-only on green', async () => {
    const green = await whereFor({ isGreen: true });
    expect(JSON.stringify(green)).not.toContain('buzzType');
    expect(green.AND.at(-1)).toEqual({ nsfwLevel: { in: [1, 2, 3] }, textNsfw: false });

    const red = await whereFor({ isGreen: false, viewerId: 4 });
    expect(JSON.stringify(red)).not.toContain('buzzType');
    expect(red.AND).toHaveLength(1);
  });

  it("shows a signed-in viewer SFW crucibles on green, and their own even when they aren't", async () => {
    const where = await whereFor({ isGreen: true, viewerId: 4 });
    expect(where.AND.at(-1)).toEqual({
      OR: [{ userId: 4 }, { nsfwLevel: { in: [1, 2, 3] }, textNsfw: false }],
    });
  });

  it('caps the level on green even when the client asks for everything', async () => {
    const where = await whereFor({ browsingLevel: 31, isGreen: true, viewerId: 4 });
    expect(where.AND[0].OR[1].AND[1].nsfwLevel.in).not.toContain(4);
    expect(where.AND[0].OR[1].AND).toContainEqual({ textNsfw: false });
  });
});

describe('getCrucibles — status for an unfiltered feed', () => {
  const findMany = dbMock.dbRead.crucible.findMany;
  const whereFor = async (input: { sort?: CrucibleSort; status?: CrucibleStatus[] }) => {
    findMany.mockResolvedValue([]);
    await getCrucibles({ input: { limit: 10, ...input }, select: { id: true } });
    return findMany.mock.calls.at(-1)![0].where;
  };

  it('limits Ending Soon to active crucibles, so long-ended ones do not lead', async () => {
    expect((await whereFor({ sort: CrucibleSort.EndingSoon })).status).toEqual({
      in: [CrucibleStatus.Active],
    });
  });

  it('keeps an explicit status on Ending Soon', async () => {
    expect(
      (await whereFor({ sort: CrucibleSort.EndingSoon, status: [CrucibleStatus.Completed] })).status
    ).toEqual({ in: [CrucibleStatus.Completed] });
  });

  it('shows only running and upcoming crucibles until a status is picked', async () => {
    await whereFor({ sort: CrucibleSort.Newest });
    expect(findMany.mock.calls.map(([args]) => args!.where!.status)).toEqual([
      { in: [CrucibleStatus.Active] },
      { in: [CrucibleStatus.Pending] },
    ]);
  });

  it('shows every picked status together', async () => {
    const picked = [CrucibleStatus.Pending, CrucibleStatus.Completed];
    expect((await whereFor({ sort: CrucibleSort.Newest, status: picked })).status).toEqual({
      in: picked,
    });
  });

  it('drops Cancelled from the picked statuses unless the caller moderates', async () => {
    const picked = [CrucibleStatus.Active, CrucibleStatus.Cancelled];
    expect((await whereFor({ sort: CrucibleSort.Newest, status: picked })).status).toEqual({
      in: [CrucibleStatus.Active],
    });
  });

  it('returns nothing for Cancelled alone unless the caller moderates', async () => {
    findMany.mockResolvedValue([{ id: 11 }]);
    const cancelled = { limit: 10, sort: CrucibleSort.Newest, status: [CrucibleStatus.Cancelled] };

    await expect(getCrucibles({ input: cancelled, select: { id: true } })).resolves.toEqual({
      items: [],
      nextCursor: undefined,
    });
    await expect(
      getCrucibles({ input: cancelled, select: { id: true }, isModerator: true })
    ).resolves.toMatchObject({ items: [{ id: 11 }] });
  });

  it('leaves out crucibles by users the viewer is blocked by', async () => {
    findMany.mockResolvedValue([]);
    const where = await sharedFeedWhere(() =>
      getCrucibles({
        input: { limit: 10, sort: CrucibleSort.Newest },
        select: { id: true },
        excludedUserIds: [7, 8],
      })
    );

    expect(where.userId).toEqual({ notIn: [7, 8] });
  });
});

describe('getCrucibles — running crucibles lead upcoming ones', () => {
  const rows = [
    { id: 1, status: CrucibleStatus.Pending, prizePool: 50_000 },
    { id: 2, status: CrucibleStatus.Active, prizePool: 100 },
    { id: 3, status: CrucibleStatus.Completed, prizePool: 90_000 },
    { id: 4, status: CrucibleStatus.Active, prizePool: 500 },
  ];

  // Prisma's status filter, prize sort, inclusive cursor and take: all that getCrucibles leans on.
  beforeEach(() => {
    dbMock.dbRead.crucible.findMany.mockImplementation((async ({
      where,
      cursor,
      take,
    }: {
      where: { status: { in: CrucibleStatus[] } };
      cursor?: { id: number };
      take: number;
    }) => {
      const order = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
        b.prizePool - a.prizePool || b.id - a.id;
      const sorted = rows.filter((row) => where.status.in.includes(row.status)).sort(order);
      // Like Prisma, a cursor is a position in the sort, whether or not its row passes the filter.
      const at = cursor && rows.find((row) => row.id === cursor.id);
      if (cursor && !at) return [];
      const from = at ? sorted.findIndex((row) => order(row, at) >= 0) : 0;
      return from < 0 ? [] : sorted.slice(from, from + take).map(({ id }) => ({ id }));
    }) as never);
    dbMock.dbRead.crucible.findUnique.mockImplementation(
      (async ({ where }: { where: { id: number } }) =>
        rows.find((row) => row.id === where.id) ?? null) as never
    );
  });

  const ids = async (input: { limit: number; status?: CrucibleStatus[]; cursor?: number }) => {
    const page = await getCrucibles({
      input: { sort: CrucibleSort.PrizePool, ...input },
      select: { id: true },
    });
    return { ids: page.items.map(({ id }) => id), nextCursor: page.nextCursor };
  };

  it('ranks an upcoming crucible with a bigger prize below every running one', async () => {
    expect((await ids({ limit: 10 })).ids).toEqual([4, 2, 1]);
  });

  it('keeps the chosen sort among the statuses picked alongside', async () => {
    const all = [CrucibleStatus.Active, CrucibleStatus.Pending, CrucibleStatus.Completed];
    expect((await ids({ limit: 10, status: all })).ids).toEqual([4, 2, 3, 1]);
    const orderBys = dbMock.dbRead.crucible.findMany.mock.calls.map(([args]) => args!.orderBy);
    expect(orderBys).toHaveLength(2);
    expect(orderBys[1]).toEqual(orderBys[0]);
    expect((orderBys[0] as unknown[])[0]).toEqual({ prizePool: 'desc' });
  });

  it('never serves more than the limit when a page spans both groups', async () => {
    const all = [CrucibleStatus.Active, CrucibleStatus.Pending, CrucibleStatus.Completed];
    expect(await ids({ limit: 2, status: all })).toEqual({ ids: [4, 2], nextCursor: 3 });
  });

  // Accepted, not designed: the cursor names only a row, so when that row is deleted between
  // pages the feed cannot know where it was and serves upcoming crucibles from the top. Before
  // the split it ended instead. Either is finite; carrying the group in the cursor would fix it.
  it('pages on from the upcoming list when the cursor crucible has gone', async () => {
    expect(await ids({ limit: 10, cursor: 99 })).toEqual({ ids: [1], nextCursor: undefined });
  });

  // Accepted, not designed: an upcoming cursor crucible that starts between pages is looked up as
  // running, so the next page serves the running ones again before the rest. Finite, like above.
  it('repeats the running crucibles when the cursor crucible has started since', async () => {
    const started = rows.find((row) => row.id === 1)!;
    started.status = CrucibleStatus.Active;
    try {
      expect(await ids({ limit: 10, cursor: 1 })).toEqual({
        ids: [1, 4, 2],
        nextCursor: undefined,
      });
    } finally {
      started.status = CrucibleStatus.Pending;
    }
  });

  it('pages across the boundary without repeating or skipping one', async () => {
    const seen: number[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < 10; page++) {
      const next = await ids({ limit: 1, cursor });
      seen.push(...next.ids);
      cursor = next.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual([4, 2, 1]);
  });
});

describe('createCrucible — prize customization fee', () => {
  it('charges nothing for the default split', async () => {
    await createCrucible(input({ prizePositions: { '1': 50, '2': 30, '3': 20 } }));

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('charges the fee for a custom split whatever the client claims about it', async () => {
    await createCrucible(input({ prizeCustomized: false }));

    expect(chargedAmounts()).toEqual([CRUCIBLE_PRIZE_CUSTOMIZATION_COST]);
  });
});

describe('createCrucible — free entries', () => {
  // Deliberately not moderator-only. Free entries move no Buzz: the pool counts only entries holding
  // a fee transaction (crucible-prizes.test.ts).
  it('lets a host who is not a moderator offer free entries', async () => {
    await createCrucible(input({ entryLimit: 3, freeEntriesPerUser: 2 }));

    expect(storedData().freeEntriesPerUser).toBe(2);
  });

  it('stores none when none are asked for', async () => {
    await createCrucible(input());

    expect(storedData().freeEntriesPerUser).toBe(0);
  });
});

describe('createCrucible — late entries', () => {
  it('warns in the last 20% and closes entries in the last 10% unless told otherwise', async () => {
    await createCrucible(input());

    expect(storedData()).toMatchObject({ entryWarningPercent: 20, entryCutoffPercent: 10 });
  });

  it('stores the shares the creator picked', async () => {
    await createCrucible(input({ entryWarningPercent: 30, entryCutoffPercent: 0 }));

    expect(storedData()).toMatchObject({ entryWarningPercent: 30, entryCutoffPercent: 0 });
  });
});

describe('createCrucible — who may create one', () => {
  it('checks the creation limits before any money moves', async () => {
    assertCanCreateCrucible.mockRejectedValue(new Error('limit reached'));

    await expect(createCrucible(input())).rejects.toThrow('limit reached');

    expect(assertCanCreateCrucible).toHaveBeenCalledWith(4);
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(crucibleCreate).not.toHaveBeenCalled();
  });

  it('lets a moderator past the creation limits', async () => {
    assertCanCreateCrucible.mockRejectedValue(new Error('limit reached'));

    await expect(createCrucible(input({ isModerator: true }))).resolves.toMatchObject({ id: 1 });
    expect(assertCanCreateCrucible).not.toHaveBeenCalled();
  });
});

describe('createCrucible — name and description', () => {
  it('runs both through the shared blocked-content guard', async () => {
    await createCrucible(input({ name: 'Neon Arena', description: 'Bright colours' }));

    expect(throwOnBlockedUserContent).toHaveBeenCalledWith(['Neon Arena', 'Bright colours'], {
      isModerator: false,
      surface: 'crucible',
    });
  });

  it('refuses profanity on an SFW-only crucible, before any money moves', async () => {
    await expect(createCrucible(input({ name: 'fuck this', nsfwLevel: 1 }))).rejects.toThrow(
      /isn't allowed on a PG or PG-13 crucible/
    );

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(crucibleCreate).not.toHaveBeenCalled();
  });

  it('allows the same language on a crucible that accepts mature content', async () => {
    await expect(
      createCrucible(input({ name: 'fuck this', nsfwLevel: 1 | 4 }))
    ).resolves.toMatchObject({ id: 1 });
  });
});

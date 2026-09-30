import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import {
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
} from '~/shared/constants/crucible.constants';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as CrucibleEligibilityService from '~/server/services/crucible-eligibility.service';
import type * as CoverImageService from '~/server/services/cover-image.service';
import { dbMock } from '~/__tests__/mocks';
import { CrucibleSort } from '~/server/common/enums';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const crucibleCreate = dbMock.dbWrite.crucible.create;
const crucibleUpdate = dbMock.dbWrite.crucible.update;
const crucibleDelete = dbMock.dbWrite.crucible.delete;
const crucibleUpdateMany = dbMock.dbWrite.crucible.updateMany;
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const assertCanCreateCrucible = vi.fn();
const throwOnBlockedUserContent = vi.fn();
const resolveCoverImageId = vi.fn();

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

const refundedPrefixes = () =>
  refundMultiAccountTransaction.mock.calls.map(([arg]) => arg.externalTransactionIdPrefix);

beforeEach(() => {
  vi.clearAllMocks();
  balance(1_000_000);
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

  it('still surfaces the original failure when the refund itself fails', async () => {
    crucibleUpdate.mockRejectedValue(new Error('db down'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('refund down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');
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
});

describe('getCrucibles — browsing level', () => {
  const findMany = dbMock.dbRead.crucible.findMany;
  const whereFor = async (opts: {
    browsingLevel?: number;
    viewerId?: number;
    isGreen?: boolean;
  }) => {
    findMany.mockResolvedValue([]);
    await getCrucibles({
      input: { limit: 10, sort: CrucibleSort.Newest, browsingLevel: opts.browsingLevel },
      select: { id: true },
      viewerId: opts.viewerId,
      isGreen: opts.isGreen,
    });
    return findMany.mock.calls.at(-1)![0].where;
  };

  it('requires both the crucible and its cover to fall inside the level', async () => {
    const where = await whereFor({ browsingLevel: 1 });
    const [visible] = where.AND;
    expect(visible.nsfwLevel.in).toContain(31);
    expect(visible.nsfwLevel.in).not.toContain(4);
    expect(visible.image.nsfwLevel.in).toEqual(visible.nsfwLevel.in);
  });

  it('always shows the viewer their own crucibles', async () => {
    const where = await whereFor({ browsingLevel: 1, viewerId: 4 });
    expect(where.AND[0].OR[0]).toEqual({ userId: 4 });
  });

  it('caps the level on green even when the client asks for everything', async () => {
    const where = await whereFor({ browsingLevel: 31, isGreen: true, viewerId: 4 });
    expect(where.AND[0].OR[1].nsfwLevel.in).not.toContain(4);
  });
});

describe('getCrucibles — status for an unfiltered feed', () => {
  const findMany = dbMock.dbRead.crucible.findMany;
  const whereFor = async (input: { sort?: CrucibleSort; status?: CrucibleStatus }) => {
    findMany.mockResolvedValue([]);
    await getCrucibles({ input: { limit: 10, ...input }, select: { id: true } });
    return findMany.mock.calls.at(-1)![0].where;
  };

  it('limits Ending Soon to active crucibles, so long-ended ones do not lead', async () => {
    expect(await whereFor({ sort: CrucibleSort.EndingSoon })).toEqual({
      status: CrucibleStatus.Active,
    });
  });

  it('keeps an explicit status on Ending Soon', async () => {
    expect(
      await whereFor({ sort: CrucibleSort.EndingSoon, status: CrucibleStatus.Completed })
    ).toEqual({ status: CrucibleStatus.Completed });
  });

  it('leaves cancelled crucibles out of the other sorts', async () => {
    expect(await whereFor({ sort: CrucibleSort.Newest })).toEqual({
      status: { not: CrucibleStatus.Cancelled },
    });
  });

  it('returns nothing for an explicit Cancelled filter unless the caller moderates', async () => {
    findMany.mockResolvedValue([{ id: 11 }]);
    const cancelled = { limit: 10, sort: CrucibleSort.Newest, status: CrucibleStatus.Cancelled };

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
    await getCrucibles({
      input: { limit: 10, sort: CrucibleSort.Newest },
      select: { id: true },
      excludedUserIds: [7, 8],
    });

    expect(findMany.mock.calls.at(-1)![0].where.userId).toEqual({ notIn: [7, 8] });
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

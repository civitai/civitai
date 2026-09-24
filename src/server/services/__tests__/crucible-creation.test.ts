import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import {
  CRUCIBLE_PRIZE_CUSTOMIZATION_COST,
  CRUCIBLE_RESOURCE_REQUIREMENTS_COST,
} from '~/shared/constants/crucible.constants';
import type * as BuzzService from '~/server/services/buzz.service';
import { dbMock } from '~/__tests__/mocks';
import { CrucibleSort } from '~/server/common/enums';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const imageCreate = dbMock.dbWrite.image.create;
const crucibleCreate = dbMock.dbWrite.crucible.create;
const crucibleUpdateMany = dbMock.dbWrite.crucible.updateMany;
const getUserBuzzAccount = vi.fn();
const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  getUserBuzzAccount,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));

const { activateScheduledCrucibles, createCrucible, getCrucibles } = await import(
  '~/server/services/crucible.service'
);

// duration 8 is free, so the customization fee is the whole setup cost.
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
  prizePositions: { '1': 50, '2': 30, '3': 20 },
  prizeCustomized: true,
  duration: 8,
  seededPrizePool: 0,
  ...overrides,
});

const balance = (amount: number) =>
  getUserBuzzAccount.mockResolvedValue([{ balance: amount, type: 'yellow' }]);

const chargedAmounts = () =>
  createMultiAccountBuzzTransaction.mock.calls.map(([arg]) => arg.amount);

const refundedPrefixes = () =>
  refundMultiAccountTransaction.mock.calls.map(([arg]) => arg.externalTransactionIdPrefix);

beforeEach(() => {
  vi.clearAllMocks();
  balance(1_000_000);
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactions: [] });
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  imageCreate.mockResolvedValue({ id: 99 });
  crucibleCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 1,
    ...data,
  }));
});

describe('createCrucible — seeded prize pool', () => {
  it('charges the seed as its own transaction on top of the setup fee', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    expect(chargedAmounts()).toEqual([SETUP_FEE, 5_000]);
  });

  it('stores the seed and the prefix that can refund it', async () => {
    await createCrucible(input({ seededPrizePool: 5_000 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.seededPrizePool).toBe(5_000);
    expect(data.seedTransactionId).toMatch(/^crucible-seed-4-/);
    expect(data.seedTransactionId).not.toBe(data.buzzTransactionId);
  });

  it('stores no seed prefix when nothing was seeded', async () => {
    await createCrucible(input({ seededPrizePool: 0 }));

    const [{ data }] = crucibleCreate.mock.calls[0];
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
      new RegExp(`${(SETUP_FEE + 5_000).toLocaleString()} Buzz`)
    );
  });
});

describe('createCrucible — a charge or write fails after money moved', () => {
  it('refunds the setup fee and creates no crucible when the seed charge fails', async () => {
    createMultiAccountBuzzTransaction.mockImplementation(async ({ amount }: { amount: number }) => {
      if (amount === 5_000) throw new Error('buzz down');
      return { transactions: [] };
    });

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('buzz down');

    expect(crucibleCreate).not.toHaveBeenCalled();
    expect(refundedPrefixes()).toEqual([expect.stringMatching(/^crucible-setup-4-/)]);
  });

  it('refunds both the setup fee and the seed when the database write fails', async () => {
    crucibleCreate.mockRejectedValue(new Error('db down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');

    expect(refundedPrefixes()).toEqual([
      expect.stringMatching(/^crucible-setup-4-/),
      expect.stringMatching(/^crucible-seed-4-/),
    ]);
  });

  it('still surfaces the original failure when the refund itself fails', async () => {
    crucibleCreate.mockRejectedValue(new Error('db down'));
    refundMultiAccountTransaction.mockRejectedValue(new Error('refund down'));

    await expect(createCrucible(input({ seededPrizePool: 5_000 }))).rejects.toThrow('db down');
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

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.status).toBe(CrucibleStatus.Pending);
    expect(data.startAt).toEqual(startAt);
    expect(data.endAt).toEqual(new Date(startAt.getTime() + 24 * HOUR));
  });

  it('starts immediately when the chosen start already passed', async () => {
    const before = Date.now();

    await createCrucible(input({ startAt: new Date(before - HOUR) }));

    const [{ data }] = crucibleCreate.mock.calls[0];
    expect(data.status).toBe(CrucibleStatus.Active);
    expect((data.startAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('starts immediately when no start was given', async () => {
    await createCrucible(input());

    const [{ data }] = crucibleCreate.mock.calls[0];
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

  it('leaves the other sorts unfiltered', async () => {
    expect(await whereFor({ sort: CrucibleSort.Newest })).toEqual({});
  });
});

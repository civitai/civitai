import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as EloService from '~/server/services/crucible-elo.service';
import { dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const findUnique = dbMock.dbRead.crucible.findUnique;
const findMany = dbMock.dbRead.crucibleEntry.findMany;
const update = dbMock.dbWrite.crucible.update;
const executeRaw = dbMock.dbWrite.$executeRaw;
const createBuzzTransactionMany = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const createNotification = vi.fn();
const getAllEntryElos = vi.fn();
const getAllVoteCounts = vi.fn();
const setTTL = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany,
  refundMultiAccountTransaction,
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification,
}));

vi.mock('~/server/redis/crucible-elo.redis', async (importOriginal) => ({
  ...(await importOriginal<typeof CrucibleEloRedis>()),
  crucibleEloRedis: { getAllVoteCounts, setTTL },
}));

vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EloService>()),
  getAllEntryElos,
}));

const { finalizeCrucible } = await import('~/server/services/crucible.service');

const dbEntry = (id: number, userId: number, createdAtMs: number) => ({
  id,
  userId,
  score: 1500,
  createdAt: new Date(createdAtMs),
});

/**
 * `finalizeCrucible` pages entries with `while (true)` until a batch comes back empty. The fake
 * must terminate on its own — an endless fake would spin the microtask queue and vitest's
 * setTimeout-based timeout would never fire, hanging CI with nothing to read.
 */
const pageEntries = (entries: ReturnType<typeof dbEntry>[]) => {
  let served = false;
  findMany.mockImplementation(async () => {
    if (served) return [];
    served = true;
    return entries;
  });
};

const setupCrucible = ({
  entryFee = 100,
  seededPrizePool = 0,
  seedTransactionId = null as string | null,
  prizePositions = { '1': 50, '2': 30, '3': 20 } as unknown,
  entries = [dbEntry(1, 10, 1_000), dbEntry(2, 11, 2_000), dbEntry(3, 12, 3_000)],
  elos = { 1: 1600, 2: 1550, 3: 1400 } as Record<number, number>,
} = {}) => {
  findUnique.mockResolvedValue({
    id: 1,
    name: 'Test Crucible',
    userId: 4,
    status: CrucibleStatus.Active,
    entryFee,
    seededPrizePool,
    seedTransactionId,
    prizePositions,
    endAt: new Date(Date.now() - 1000),
    _count: { entries: entries.length },
  });
  pageEntries(entries);
  getAllEntryElos.mockResolvedValue(elos);
};

beforeEach(() => {
  vi.clearAllMocks();
  getAllVoteCounts.mockResolvedValue({});
  setTTL.mockResolvedValue(undefined);
  update.mockResolvedValue({});
  executeRaw.mockResolvedValue(1);
  createBuzzTransactionMany.mockImplementation(async (transactions: unknown[]) => ({
    transactions,
  }));
  createNotification.mockResolvedValue(undefined);
  refundMultiAccountTransaction.mockResolvedValue(undefined);
  setupCrucible();
});

describe('prize pool', () => {
  it('is the entry fee times the number of entries', async () => {
    setupCrucible({ entryFee: 250 });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(750);
  });

  it('is zero for a free crucible', async () => {
    setupCrucible({ entryFee: 0 });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(0);
    expect(result.totalPrizesDistributed).toBe(0);
  });
});

describe('prize distribution', () => {
  it('pays each position its configured percentage of the pool', async () => {
    // The stored shape is the `z.record` the create schema validates — `{"1": 50, ...}`, an
    // object. Reading it as an array alone returned [] here, so every entry got prizeAmount 0
    // while the pool was still collected. That is the regression this asserts against.
    setupCrucible({ entryFee: 100, prizePositions: { '1': 50, '2': 30, '3': 20 } });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(300);
    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([150, 90, 60]);
    expect(result.totalPrizesDistributed).toBe(300);
  });

  it('still reads the legacy array shape', async () => {
    setupCrucible({
      entryFee: 100,
      prizePositions: [
        { position: 1, percentage: 50 },
        { position: 2, percentage: 30 },
        { position: 3, percentage: 20 },
      ],
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([150, 90, 60]);
  });

  it('pays nothing to positions with no configured percentage', async () => {
    setupCrucible({ entryFee: 100, prizePositions: { '1': 100 } });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([300, 0, 0]);
  });

  it('rounds down, so the pool can never be overspent', async () => {
    // 3 entries x 100 = 300; 33% of 300 is 99 exactly, 34% is 102 — use a pool that does not divide
    setupCrucible({ entryFee: 33, prizePositions: { '1': 50, '2': 50 } });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(99);
    expect(result.totalPrizesDistributed).toBeLessThanOrEqual(99);
    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([49, 49, 0]);
  });

  it('transfers the pool from the central bank to each winner', async () => {
    setupCrucible({ entryFee: 100, prizePositions: { '1': 60, '2': 40 } });

    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).toHaveBeenCalledTimes(1);
    const [transactions] = createBuzzTransactionMany.mock.calls[0];
    expect(transactions).toHaveLength(2);
    expect(
      transactions.map((t: { toAccountId: number; amount: number }) => [t.toAccountId, t.amount])
    ).toEqual([
      [10, 180],
      [11, 120],
    ]);
    expect(transactions.every((t: { fromAccountId: number }) => t.fromAccountId === 0)).toBe(true);
  });

  it('issues no Buzz transaction when nothing is owed', async () => {
    setupCrucible({ entryFee: 0 });

    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('ignores prize positions beyond the number of entries', async () => {
    setupCrucible({
      entryFee: 100,
      prizePositions: { '1': 40, '2': 30, '3': 20, '4': 10 },
    });

    const result = await finalizeCrucible(1);

    // Only 3 entries exist, so position 4's 10% is simply not paid.
    expect(result.finalEntries).toHaveLength(3);
    expect(result.totalPrizesDistributed).toBe(120 + 90 + 60);
  });

  it('ignores malformed position keys rather than paying NaN', async () => {
    setupCrucible({
      entryFee: 100,
      prizePositions: { '1': 50, banana: 30, '-2': 10, '0': 10 },
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([150, 0, 0]);
    expect(Number.isNaN(result.totalPrizesDistributed)).toBe(false);
  });
});

describe('prize notifications', () => {
  it('tells each winner what they placed and won', async () => {
    setupCrucible({ entryFee: 100, prizePositions: { '1': 100 } });

    await finalizeCrucible(1);

    const won = createNotification.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.type === 'crucible-won');

    expect(won.length).toBeGreaterThan(0);
    const winner = won.find((arg) => arg.userId === 10);
    expect(winner?.details).toMatchObject({ position: 1, prizeAmount: 300 });
  });

  it('notifies a non-winning participant with a zero prize rather than staying silent', async () => {
    setupCrucible({ entryFee: 100, prizePositions: { '1': 100 } });

    await finalizeCrucible(1);

    const won = createNotification.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.type === 'crucible-won');
    const loser = won.find((arg) => arg.userId === 12);

    expect(loser?.details).toMatchObject({ position: 3, prizeAmount: 0 });
  });
});

describe('seeded prize pool', () => {
  it('adds the creator seed on top of the entry fees', async () => {
    setupCrucible({ entryFee: 250, seededPrizePool: 1_000 });

    const result = await finalizeCrucible(1);

    // 3 entries x 250 = 750, plus the 1,000 seed
    expect(result.totalPrizePool).toBe(1_750);
  });

  it('is the whole pool when entry is free, and still pays out', async () => {
    setupCrucible({
      entryFee: 0,
      seededPrizePool: 900,
      prizePositions: { '1': 50, '2': 30, '3': 20 },
    });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(900);
    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([450, 270, 180]);
    expect(result.totalPrizesDistributed).toBe(900);
  });

  it('keeps rounding down against the seeded pool, so it cannot be overspent', async () => {
    // 3 x 33 = 99 plus a 2 seed = 101; 50% of 101 is 50.5
    setupCrucible({ entryFee: 33, seededPrizePool: 2, prizePositions: { '1': 50, '2': 50 } });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(101);
    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([50, 50, 0]);
    expect(result.totalPrizesDistributed).toBeLessThanOrEqual(101);
  });

  it('pays the seed to the winners, not just the entry fees', async () => {
    setupCrucible({ entryFee: 100, seededPrizePool: 600, prizePositions: { '1': 100 } });

    await finalizeCrucible(1);

    const [transactions] = createBuzzTransactionMany.mock.calls[0];
    // 300 of entry fees + 600 seed, all to first place
    expect(
      transactions.map((t: { toAccountId: number; amount: number }) => [t.toAccountId, t.amount])
    ).toEqual([[10, 900]]);
  });
});

describe('seeded prize pool — entries but no prize awarded', () => {
  it('returns the seed when every floored share rounds to zero', async () => {
    // 1 Buzz seed, no entry fee, split three ways: floor() takes every share to 0, so the pool is
    // charged and nothing is paid out.
    setupCrucible({
      entryFee: 0,
      seededPrizePool: 1,
      seedTransactionId: 'crucible-seed-4-xyz',
      prizePositions: { '1': 50, '2': 30, '3': 20 },
    });

    const result = await finalizeCrucible(1);

    expect(result.totalPrizesDistributed).toBe(0);
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'crucible-seed-4-xyz' })
    );
  });

  it('returns the seed when prizePositions awards nothing', async () => {
    setupCrucible({
      entryFee: 0,
      seededPrizePool: 5_000,
      seedTransactionId: 'crucible-seed-4-xyz',
      prizePositions: {},
    });

    await finalizeCrucible(1);

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'crucible-seed-4-xyz' })
    );
  });

  it('does not refund when prizes actually went out', async () => {
    setupCrucible({
      entryFee: 0,
      seededPrizePool: 900,
      seedTransactionId: 'crucible-seed-4-xyz',
      prizePositions: { '1': 50, '2': 30, '3': 20 },
    });

    await finalizeCrucible(1);

    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('seeded prize pool — nobody entered', () => {
  const setupUnentered = (overrides: Record<string, unknown> = {}) => {
    findUnique.mockResolvedValue({
      id: 1,
      name: 'Test Crucible',
      userId: 4,
      status: CrucibleStatus.Active,
      entryFee: 100,
      seededPrizePool: 5_000,
      seedTransactionId: 'crucible-seed-4-abc',
      prizePositions: { '1': 100 },
      endAt: new Date(Date.now() - 1000),
      _count: { entries: 0 },
      ...overrides,
    });
  };

  it('reports the seed as the pool rather than zero', async () => {
    setupUnentered();

    const result = await finalizeCrucible(1);

    expect(result.totalPrizePool).toBe(5_000);
    expect(result.totalPrizesDistributed).toBe(0);
  });

  it('returns the seed to the creator instead of stranding it in the bank', async () => {
    setupUnentered();

    await finalizeCrucible(1);

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'crucible-seed-4-abc' })
    );
  });

  it('refunds nothing when there was no seed', async () => {
    setupUnentered({ seededPrizePool: 0, seedTransactionId: null });

    await finalizeCrucible(1);

    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  it('still completes the crucible when the seed refund fails', async () => {
    setupUnentered();
    refundMultiAccountTransaction.mockRejectedValue(new Error('buzz down'));

    await expect(finalizeCrucible(1)).resolves.toMatchObject({ totalPrizesDistributed: 0 });
    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Completed },
    });
  });
});

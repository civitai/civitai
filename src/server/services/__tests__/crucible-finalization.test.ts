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
const createNotification = vi.fn();
const getAllEntryElos = vi.fn();
const getAllVoteCounts = vi.fn();
const setTTL = vi.fn();

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createBuzzTransactionMany,
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
 * The entry loader is a `while (true)` cursor loop that stops on an empty batch. A fake that keeps
 * serving rows would spin the microtask queue forever, and vitest's setTimeout-based timeout can
 * never fire against a pure microtask loop — so this terminates by construction, and the paging
 * test below asserts it stopped.
 */
const pageEntries = (batches: ReturnType<typeof dbEntry>[][]) => {
  let call = 0;
  findMany.mockImplementation(async () => batches[call++] ?? []);
};

const setupCrucible = ({
  status = CrucibleStatus.Active,
  entryFee = 0,
  entries = [dbEntry(1, 10, 1_000), dbEntry(2, 11, 2_000), dbEntry(3, 12, 3_000)],
  elos = { 1: 1600, 2: 1550, 3: 1400 } as Record<number, number>,
  voteCounts = {} as Record<number, number>,
} = {}) => {
  findUnique.mockResolvedValue({
    id: 1,
    name: 'Test Crucible',
    userId: 4,
    status,
    entryFee,
    prizePositions: { '1': 50, '2': 30, '3': 20 },
    endAt: new Date(Date.now() - 1000),
    _count: { entries: entries.length },
  });
  pageEntries([entries]);
  getAllEntryElos.mockResolvedValue(elos);
  getAllVoteCounts.mockResolvedValue(voteCounts);
};

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({});
  executeRaw.mockResolvedValue(1);
  createBuzzTransactionMany.mockImplementation(async (transactions: unknown[]) => ({
    transactions,
  }));
  createNotification.mockResolvedValue(undefined);
  setTTL.mockResolvedValue(undefined);
  setupCrucible();
});

describe('finalizeCrucible — guards', () => {
  it('throws when the crucible does not exist', async () => {
    findUnique.mockResolvedValue(null);
    await expect(finalizeCrucible(404)).rejects.toThrow();
  });

  it('refuses to finalize twice', async () => {
    setupCrucible({ status: CrucibleStatus.Completed });
    await expect(finalizeCrucible(1)).rejects.toThrow();
  });

  it('refuses to finalize a cancelled crucible', async () => {
    setupCrucible({ status: CrucibleStatus.Cancelled });
    await expect(finalizeCrucible(1)).rejects.toThrow();
  });

  it('pays nothing when it refuses', async () => {
    setupCrucible({ status: CrucibleStatus.Completed });
    await finalizeCrucible(1).catch(() => undefined);
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('finalizeCrucible — positions', () => {
  it('ranks by ELO descending', async () => {
    setupCrucible({ elos: { 1: 1400, 2: 1600, 3: 1500 } });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => [e.entryId, e.position])).toEqual([
      [2, 1],
      [3, 2],
      [1, 3],
    ]);
  });

  it('breaks an ELO tie in favour of the earlier entry', async () => {
    setupCrucible({
      entries: [dbEntry(1, 10, 5_000), dbEntry(2, 11, 1_000), dbEntry(3, 12, 3_000)],
      elos: { 1: 1500, 2: 1500, 3: 1500 },
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => e.entryId)).toEqual([2, 3, 1]);
  });

  it('assigns contiguous positions starting at 1', async () => {
    const result = await finalizeCrucible(1);
    expect(result.finalEntries.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('uses the database score when Redis has no ELO for an entry', async () => {
    setupCrucible({
      entries: [
        { ...dbEntry(1, 10, 1_000), score: 1200 },
        { ...dbEntry(2, 11, 2_000), score: 1800 },
      ],
      elos: {},
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => [e.entryId, e.finalScore])).toEqual([
      [2, 1800],
      [1, 1200],
    ]);
  });

  it('carries the Redis vote count onto each finalized entry', async () => {
    setupCrucible({ voteCounts: { 1: 7, 2: 3 } });

    const result = await finalizeCrucible(1);
    const byId = Object.fromEntries(result.finalEntries.map((e) => [e.entryId, e.voteCount]));

    expect(byId).toMatchObject({ 1: 7, 2: 3, 3: 0 });
  });
});

describe('finalizeCrucible — entry paging', () => {
  it('keeps paging until a batch comes back empty', async () => {
    const first = Array.from({ length: 2 }, (_, i) => dbEntry(i + 1, 10 + i, 1_000 * (i + 1)));
    const second = [dbEntry(3, 13, 4_000)];
    findUnique.mockResolvedValue({
      id: 1,
      name: 'Test Crucible',
      userId: 4,
      status: CrucibleStatus.Active,
      entryFee: 0,
      prizePositions: {},
      endAt: new Date(Date.now() - 1000),
      _count: { entries: 3 },
    });
    pageEntries([first, second]);
    getAllEntryElos.mockResolvedValue({});

    const result = await finalizeCrucible(1);

    expect(result.finalEntries).toHaveLength(3);
    // Two pages of rows, then the empty page that ends the loop.
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('advances the cursor rather than refetching the first page forever', async () => {
    await finalizeCrucible(1);

    const secondCall = findMany.mock.calls[1]?.[0];
    expect(secondCall?.cursor).toEqual({ id: 3 });
    expect(secondCall?.skip).toBe(1);
  });
});

describe('finalizeCrucible — completion', () => {
  it('marks the crucible Completed', async () => {
    await finalizeCrucible(1);

    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Completed },
    });
  });

  it('writes the final scores and positions back to Postgres', async () => {
    await finalizeCrucible(1);
    expect(executeRaw).toHaveBeenCalled();
  });

  it('expires the Redis ELO data instead of leaving it indefinitely', async () => {
    await finalizeCrucible(1);
    expect(setTTL).toHaveBeenCalledWith(1, 7 * 24 * 60 * 60);
  });

  it('notifies the creator that the crucible ended', async () => {
    await finalizeCrucible(1);

    const ended = createNotification.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === 'crucible-ended');

    expect(ended?.userId).toBe(4);
    expect(ended?.details).toMatchObject({ crucibleId: 1, totalEntries: 3 });
  });
});

describe('finalizeCrucible — empty crucible', () => {
  const setupEmpty = () => {
    findUnique.mockResolvedValue({
      id: 1,
      name: 'Test Crucible',
      userId: 4,
      status: CrucibleStatus.Active,
      entryFee: 100,
      prizePositions: { '1': 100 },
      endAt: new Date(Date.now() - 1000),
      _count: { entries: 0 },
    });
  };

  it('completes with no entries and no prize pool', async () => {
    setupEmpty();

    const result = await finalizeCrucible(1);

    expect(result.finalEntries).toEqual([]);
    expect(result.totalPrizePool).toBe(0);
    expect(result.totalPrizesDistributed).toBe(0);
  });

  it('still marks it Completed so it cannot be finalized again', async () => {
    setupEmpty();

    await finalizeCrucible(1);

    expect(update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: CrucibleStatus.Completed },
    });
  });

  it('moves no Buzz', async () => {
    setupEmpty();

    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('finalizeCrucible — single entry', () => {
  it('awards first place to the only entrant', async () => {
    setupCrucible({ entryFee: 100, entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries).toHaveLength(1);
    expect(result.finalEntries[0]).toMatchObject({ entryId: 1, position: 1 });
    expect(result.totalPrizePool).toBe(100);
    expect(result.finalEntries[0].prizeAmount).toBe(50); // position 1 takes 50%
  });
});

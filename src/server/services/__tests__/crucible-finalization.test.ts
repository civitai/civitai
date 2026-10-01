import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as NotificationService from '~/server/services/notification.service';
import type * as CrucibleEloRedis from '~/server/redis/crucible-elo.redis';
import type * as EloService from '~/server/services/crucible-elo.service';
import { loggingMock, dbMock } from '~/__tests__/mocks';

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
  voteCount: 0,
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
  seededPrizePool = 0,
  entries = [dbEntry(1, 10, 1_000), dbEntry(2, 11, 2_000), dbEntry(3, 12, 3_000)],
  elos = { 1: 1600, 2: 1550, 3: 1400 } as Record<number, number>,
  voteCounts = {} as Record<number, number>,
  ingestion = CrucibleIngestionStatus.Scanned,
} = {}) => {
  findUnique.mockResolvedValue({
    id: 1,
    name: 'Test Crucible',
    ingestion,
    textNsfw: false,
    userId: 4,
    status,
    entryFee,
    seededPrizePool,
    seedTransactionId: null,
    prizePositions: { '1': 50, '2': 30, '3': 20 },
    endAt: new Date(Date.now() - 1000),
    nsfwLevel: 1,
    _count: { entries: entries.length },
  });
  pageEntries([entries]);
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([
    { crucibleId: 1, _count: { _all: entries.length } },
  ]);
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
  it("ranks every entry except a blocked one or one re-rated outside the crucible's levels", async () => {
    await finalizeCrucible(1);

    const { where } = dbMock.dbRead.crucibleEntry.findMany.mock.calls[0][0];
    expect(where).toEqual({
      crucibleId: 1,
      image: {
        ingestion: { not: ImageIngestionStatus.Blocked },
        nsfwLevel: { in: expect.arrayContaining([1, 3]) },
      },
    });
    expect(where.image.nsfwLevel.in).not.toContain(2);
  });

  it('holds the money for review, loudly, when every entry is disqualified', async () => {
    setupCrucible({ entries: [] });
    findUnique.mockResolvedValue({ ...(await findUnique()), _count: { entries: 3 } });

    await finalizeCrucible(1);

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'crucible-finalize-all-disqualified' })
    );
  });

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

  it('clears earlier positions first, so a retry leaves none on an entry that no longer ranks', async () => {
    const clear = dbMock.dbWrite.crucibleEntry.updateMany;
    clear.mockResolvedValue({ count: 0 });

    await finalizeCrucible(1);

    expect(clear).toHaveBeenCalledWith({
      where: { crucibleId: 1, position: { not: null } },
      data: { position: null },
    });
    expect(clear.mock.invocationCallOrder[0]).toBeLessThan(executeRaw.mock.invocationCallOrder[0]);
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
      seededPrizePool: 0,
      seedTransactionId: null,
      prizePositions: { '1': 100 },
      endAt: new Date(Date.now() - 1000),
      _count: { entries: 0 },
    });
    dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
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
    expect(result.finalEntries[0].prizeAmount).toBe(100);
  });

  it('names and links the crucible on the prize transaction', async () => {
    setupCrucible({ entryFee: 100, entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });

    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({
        toAccountId: 10,
        description: 'Crucible prize - 1st place: Test Crucible',
        details: expect.objectContaining({ entityId: 1, entityType: 'Crucible' }),
      }),
    ]);
  });

  it('leaves a name still under review off the prize transaction', async () => {
    setupCrucible({
      entryFee: 100,
      entries: [dbEntry(1, 10, 1_000)],
      elos: { 1: 1500 },
      ingestion: CrucibleIngestionStatus.Pending,
    });

    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({ description: 'Crucible prize - 1st place' }),
    ]);
  });
});

describe('finalizeCrucible — minimum votes to place', () => {
  // Votes 20/18/16/2 average 14, so an entry needs 11 (75%, rounded up) to place.
  const fourEntries = [
    dbEntry(1, 10, 1_000),
    dbEntry(2, 11, 2_000),
    dbEntry(3, 12, 3_000),
    dbEntry(4, 13, 4_000),
  ];

  it('leaves an entry under the minimum unplaced, even with the top score', async () => {
    setupCrucible({
      entries: fourEntries,
      elos: { 1: 1550, 2: 1520, 3: 1480, 4: 1560 },
      voteCounts: { 1: 20, 2: 18, 3: 16, 4: 2 },
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.map((e) => [e.entryId, e.position])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, null],
    ]);
    expect(result.finalEntries.find((e) => e.entryId === 4)?.prizeAmount).toBe(0);
  });

  it('places an entry sitting exactly on the minimum', async () => {
    // Average 12 → exactly 9.
    setupCrucible({
      entries: fourEntries,
      elos: { 1: 1550, 2: 1520, 3: 1580, 4: 1450 },
      voteCounts: { 1: 12, 2: 12, 3: 9, 4: 15 },
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.find((e) => e.entryId === 3)?.position).toBe(1);
  });

  it("splits an unplaced entry's would-be place among the placed winners", async () => {
    setupCrucible({
      entryFee: 100,
      elos: { 1: 1500, 2: 1450, 3: 1600 },
      voteCounts: { 1: 10, 2: 10, 3: 0 },
    });

    const result = await finalizeCrucible(1);

    // 50/30/20 of a 300 pool with only two placed: 50 and 30 scale to 62.5% and 37.5%.
    expect(result.finalEntries.map((e) => [e.entryId, e.prizeAmount])).toEqual([
      [1, 187],
      [2, 112],
      [3, 0],
    ]);
  });

  it('writes a null position for the unplaced entry', async () => {
    setupCrucible({
      entries: fourEntries,
      elos: { 1: 1550, 2: 1520, 3: 1480, 4: 1560 },
      voteCounts: { 1: 20, 2: 18, 3: 16, 4: 2 },
    });

    await finalizeCrucible(1);

    const values = executeRaw.mock.calls.flatMap(
      ([, rows]) => (rows as { values: unknown[] }).values
    );
    // (entryId, score, position, voteCount) for entry 4.
    expect(values.slice(12, 16)).toEqual([4, 1560, null, 2]);
  });

  it('tells an unplaced entrant they were not placed rather than naming a position', async () => {
    setupCrucible({
      entries: fourEntries,
      elos: { 1: 1550, 2: 1520, 3: 1480, 4: 1560 },
      voteCounts: { 1: 20, 2: 18, 3: 16, 4: 2 },
    });

    await finalizeCrucible(1);

    const won = createNotification.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === 'crucible-won' && arg.userId === 13);
    expect(won?.details).toMatchObject({ position: null, prizeAmount: 0 });
  });

  it('falls back to the synced vote counts when Redis has lost them', async () => {
    setupCrucible({
      entries: fourEntries.map((entry, i) => ({ ...entry, voteCount: [20, 18, 16, 2][i] })),
      elos: { 1: 1550, 2: 1520, 3: 1480, 4: 1560 },
      voteCounts: {},
    });

    const result = await finalizeCrucible(1);

    expect(result.finalEntries.find((e) => e.entryId === 4)).toMatchObject({
      position: null,
      voteCount: 2,
    });
    expect(result.finalEntries.find((e) => e.entryId === 1)?.voteCount).toBe(20);
  });

  it("names a user's placed entry over their unplaced one", async () => {
    setupCrucible({
      entries: [dbEntry(1, 10, 1_000), dbEntry(2, 11, 2_000), dbEntry(3, 10, 3_000)],
      elos: { 1: 1450, 2: 1500, 3: 1600 },
      voteCounts: { 1: 10, 2: 10, 3: 0 },
    });

    await finalizeCrucible(1);

    const won = createNotification.mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg.type === 'crucible-won' && arg.userId === 10);
    expect(won?.details).toMatchObject({ position: 2 });
  });
});

describe('finalizeCrucible — fewer entries than paid places', () => {
  it('splits the unfilled places among the winners in proportion to their shares', async () => {
    setupCrucible({
      entryFee: 100,
      entries: [dbEntry(1, 10, 1_000), dbEntry(2, 11, 2_000)],
      elos: { 1: 1600, 2: 1400 },
    });

    const result = await finalizeCrucible(1);

    // 50/30/20 with no third place: 50 and 30 scale to 62.5% and 37.5% of the 200 pool.
    expect(result.finalEntries.map((e) => e.prizeAmount)).toEqual([125, 75]);
    expect(result.totalPrizesDistributed).toBe(200);
  });
});

import { Prisma } from '@prisma/client';
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
import type * as PostService from '~/server/services/post.service';
import type * as PrizeService from '~/server/services/prize.service';
import { loggingMock, dbMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md.
const findUnique = dbMock.dbWrite.crucible.findUnique;
const findMany = dbMock.dbWrite.crucibleEntry.findMany;
const claim = dbMock.dbWrite.crucible.updateMany;
const executeRaw = dbMock.dbWrite.$executeRaw;
const createBuzzTransactionMany = vi.fn();
const createNotification = vi.fn();
const getAllEntryElos = vi.fn();
const getAllVoteCounts = vi.fn();
const setTTL = vi.fn();
const afterPostsPublish = vi.fn();
const createPrizes = vi.fn();
const voidPrizes = vi.fn();

vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PostService>()),
  afterPostsPublish,
}));

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

vi.mock('~/server/services/prize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PrizeService>()),
  createPrizes,
  voidPrizes,
}));

type AwardedPrize = {
  userId: number;
  sourceType: string;
  sourceId: number;
  subjectId: number;
  position: number;
  amount: number;
  title: string;
  externalTransactionId: string;
};
const awarded = (call = 0) => createPrizes.mock.calls[call][0] as AwardedPrize[];

const { finalizeCrucible } = await import('~/server/services/crucible.service');

const dbEntry = (
  id: number,
  userId: number,
  createdAtMs: number,
  { position = null as number | null, score = 1500, voteCount = 0 } = {}
) => ({
  id,
  userId,
  score,
  voteCount,
  position,
  createdAt: new Date(createdAtMs),
});

const entryWrites = () =>
  executeRaw.mock.calls.filter(([strings]) =>
    (strings as TemplateStringsArray).join('').includes('UPDATE "CrucibleEntry"')
  );

/**
 * The entry loader is a `while (true)` cursor loop that stops on an empty batch. A fake that keeps
 * serving rows would spin the microtask queue forever, and vitest's setTimeout-based timeout can
 * never fire against a pure microtask loop — so this terminates by construction, and the paging
 * test below asserts it stopped.
 */
const pageEntries = (batches: ReturnType<typeof dbEntry>[][]) => {
  let call = 0;
  const entries = batches.flat();
  findMany.mockImplementation(async (args: { where: { position?: unknown } }) =>
    args.where.position ? storedPlaces(entries) : batches[call++] ?? []
  );
};

/** The places query reads back what the ranking write stored, else what the fixture holds. */
const storedPlaces = (entries: ReturnType<typeof dbEntry>[]) => {
  const values = entryWrites().flatMap(
    ([, rows]) => (rows as { values: (number | null)[] }).values
  );
  const written = Array.from({ length: values.length / 4 }, (_, i) => {
    const [id, score, position, voteCount] = values.slice(i * 4, i * 4 + 4) as number[];
    return { ...entries.find((e) => e.id === id)!, score, position, voteCount };
  });
  return (written.length ? written : entries)
    .filter((entry) => entry.position !== null)
    .sort((a, b) => a.position! - b.position!);
};

const rankableLoads = () =>
  findMany.mock.calls.filter(
    ([args]) => !(args as { where: { position?: unknown } }).where.position
  );

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
    image: { ingestion: ImageIngestionStatus.Scanned },
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
  dbMock.dbWrite.crucibleEntry.groupBy.mockResolvedValue([
    { crucibleId: 1, _count: { _all: entries.length } },
  ]);
  getAllEntryElos.mockResolvedValue(elos);
  getAllVoteCounts.mockResolvedValue(voteCounts);
};

beforeEach(() => {
  vi.clearAllMocks();
  claim.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(0);
  executeRaw.mockResolvedValue(1);
  createBuzzTransactionMany.mockImplementation(async (transactions: unknown[]) => ({
    transactions,
    conflicts: [],
  }));
  createPrizes.mockImplementation(async (inputs: AwardedPrize[]) =>
    inputs.map((input, i) => ({ ...input, id: 100 + i }))
  );
  voidPrizes.mockResolvedValue(0);
  createNotification.mockResolvedValue(undefined);
  setTTL.mockResolvedValue(undefined);
  afterPostsPublish.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
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
    expect(createPrizes).not.toHaveBeenCalled();
    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

describe('finalizeCrucible — positions', () => {
  it("ranks every entry except a blocked, held, flagged or unpublished one, or one re-rated outside the crucible's levels", async () => {
    await finalizeCrucible(1);

    const { where } = findMany.mock.calls[0][0];
    expect(where).toEqual({
      crucibleId: 1,
      image: {
        needsReview: null,
        tosViolation: false,
        post: { publishedAt: { not: null } },
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
    const ended = createNotification.mock.calls.find(([n]) => n.type === 'crucible-ended')?.[0];
    expect(ended?.details).toMatchObject({ totalEntries: 0, disqualifiedEntries: 3 });
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
    expect(rankableLoads()).toHaveLength(3);
  });

  it('advances the cursor rather than refetching the first page forever', async () => {
    await finalizeCrucible(1);

    const secondCall = findMany.mock.calls[1]?.[0];
    expect(secondCall?.cursor).toEqual({ id: 3 });
    expect(secondCall?.skip).toBe(1);
  });
});

describe('finalizeCrucible — completion', () => {
  it('marks the crucible Completed only while it is still Active', async () => {
    await finalizeCrucible(1);

    expect(claim).toHaveBeenCalledWith({
      where: { id: 1, status: CrucibleStatus.Active },
      data: { status: CrucibleStatus.Completed },
    });
  });

  it('awards the prizes before it claims Completed, and pays none of them itself', async () => {
    setupCrucible({ entryFee: 100 });
    await finalizeCrucible(1);

    expect(createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(createPrizes).toHaveBeenCalled();
    expect(createPrizes.mock.invocationCallOrder[0]).toBeLessThan(
      claim.mock.invocationCallOrder[0]
    );
  });

  it('leaves it Active for the next run when awarding fails, and says so', async () => {
    setupCrucible({ entryFee: 100 });
    createPrizes.mockRejectedValue(new Error('db down'));

    await expect(finalizeCrucible(1)).rejects.toThrow('db down');

    expect(claim).not.toHaveBeenCalled();
    expect(setTTL).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'crucible-prize-award-failed',
        crucibleId: 1,
      })
    );
  });

  it('awards the same ledger keys on a retry, so a prize is only ever recorded and paid once', async () => {
    setupCrucible({ entryFee: 100 });
    await finalizeCrucible(1);
    // The retry finds the first attempt's ranking stored, with the scores moved since.
    setupCrucible({ entryFee: 100, elos: { 1: 1400, 2: 1500, 3: 1700 } });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(3);
    await finalizeCrucible(1);

    const ids = createPrizes.mock.calls.map(([prizes]) =>
      (prizes as AwardedPrize[]).map((prize) => prize.externalTransactionId)
    );
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]).toEqual([
      'crucible-prize-1-1-1',
      'crucible-prize-1-2-2',
      'crucible-prize-1-3-3',
    ]);
  });

  it('voids what it awarded, notifies nobody and logs when it lost the claim', async () => {
    setupCrucible({ entryFee: 100 });
    claim.mockResolvedValue({ count: 0 });

    await finalizeCrucible(1);

    expect(voidPrizes).toHaveBeenCalledWith('Crucible', 1);
    expect(createNotification).not.toHaveBeenCalled();
    expect(setTTL).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-finalize-claim-lost', prizesAwarded: true })
    );
  });

  it('voids nothing when it wins the claim', async () => {
    setupCrucible({ entryFee: 100 });

    await finalizeCrucible(1);

    expect(voidPrizes).not.toHaveBeenCalled();
  });

  it('on a retry, pays the ranking the earlier attempt wrote rather than ranking again', async () => {
    // Today's scores would put entry 1 first; the earlier attempt placed entry 2 first.
    setupCrucible({
      entryFee: 100,
      entries: [
        dbEntry(1, 10, 1_000, { position: 2, score: 1490 }),
        dbEntry(2, 11, 2_000, { position: 1, score: 1510 }),
        dbEntry(3, 12, 3_000),
      ],
      elos: { 1: 1700, 2: 1400, 3: 1500 },
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(2);

    const result = await finalizeCrucible(1);

    expect(awarded().map((prize) => prize.externalTransactionId)).toEqual([
      'crucible-prize-1-2-1',
      'crucible-prize-1-1-2',
    ]);
    expect(result.finalEntries.find((e) => e.entryId === 3)).toMatchObject({ position: null });
    expect(entryWrites()).toHaveLength(0);
  });

  it('writes the ranking in one transaction holding the crucible row, so runs cannot both rank', async () => {
    await finalizeCrucible(1);

    expect(entryWrites()).toHaveLength(1);
    const [lock] = dbMock.dbWrite.$queryRaw.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join('?').replace(/\s+/g, ' ')
    );
    expect(lock).toBe('SELECT id FROM "Crucible" WHERE id = ? FOR UPDATE');
    expect(dbMock.dbWrite.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      executeRaw.mock.invocationCallOrder.at(-1)!
    );
  });

  it('pays the ranking another run already wrote instead of writing its own', async () => {
    setupCrucible({
      entryFee: 100,
      entries: [
        dbEntry(1, 10, 1_000, { position: 1 }),
        dbEntry(2, 11, 2_000),
        dbEntry(3, 12, 3_000),
      ],
      elos: { 1: 1400, 2: 1700, 3: 1600 },
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(1);

    await finalizeCrucible(1);

    expect(entryWrites()).toHaveLength(0);
    expect(awarded().map((prize) => prize.externalTransactionId)).toEqual(['crucible-prize-1-1-1']);
  });

  it("pays a stored winner whose image stopped ranking, and doesn't hand the seed back", async () => {
    setupCrucible({ entryFee: 100, entries: [dbEntry(2, 11, 2_000), dbEntry(3, 12, 3_000)] });
    findUnique.mockResolvedValue({
      ...(await findUnique()),
      seededPrizePool: 500,
      seedTransactionId: 'crucible-seed-4-abc',
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(1);
    // Entry 1 placed first in the earlier attempt, then its image was deleted.
    findMany.mockImplementation(async (args: { where: { position?: unknown } }) =>
      args.where.position ? [dbEntry(1, 10, 1_000, { position: 1 })] : []
    );

    await finalizeCrucible(1);

    expect(awarded()).toEqual([
      expect.objectContaining({ externalTransactionId: 'crucible-prize-1-1-1', userId: 10 }),
    ]);
  });

  it('refuses before the crucible has ended by the database clock, paying nothing', async () => {
    setupCrucible({ entryFee: 100 });
    executeRaw.mockResolvedValueOnce(0);

    await expect(finalizeCrucible(1)).rejects.toThrow('not ended');

    expect(createPrizes).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('takes the row lock before it reads the crucible or its entries', async () => {
    await finalizeCrucible(1);

    const [strings] = executeRaw.mock.calls[0] as [TemplateStringsArray];
    expect(strings.join('?').replace(/\s+/g, ' ')).toContain(
      'UPDATE "Crucible" SET status = status WHERE id = ? AND status = ?::"CrucibleStatus" AND "endAt" <= now()'
    );
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0]
    );
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      findMany.mock.invocationCallOrder[0]
    );
  });

  it('writes the final scores and positions back to Postgres', async () => {
    await finalizeCrucible(1);
    expect(entryWrites()).toHaveLength(1);
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
    dbMock.dbWrite.crucibleEntry.groupBy.mockResolvedValue([]);
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

    expect(claim).toHaveBeenCalledWith({
      where: { id: 1, status: CrucibleStatus.Active },
      data: { status: CrucibleStatus.Completed },
    });
  });

  it('moves no Buzz', async () => {
    setupEmpty();

    await finalizeCrucible(1);

    expect(createPrizes).not.toHaveBeenCalled();
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

  // The winner picks the currency when claiming, so nothing at award time may fix one.
  it('awards plain Buzz, for a crucible created on the green site too', async () => {
    setupCrucible({ entryFee: 100 });
    findUnique.mockResolvedValue({ ...(await findUnique()), buzzType: 'green' });

    await finalizeCrucible(1);

    expect(awarded()).toHaveLength(3);
    for (const prize of awarded()) {
      expect(prize).not.toHaveProperty('buzzType');
      expect(prize.sourceType).toBe('Crucible');
    }
  });

  it('names and links the crucible on the prize', async () => {
    setupCrucible({ entryFee: 100, entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });

    await finalizeCrucible(1);

    expect(awarded()).toEqual([
      {
        userId: 10,
        sourceType: 'Crucible',
        sourceId: 1,
        subjectId: 1,
        position: 1,
        amount: 100,
        title: 'Crucible 1st prize: Test Crucible',
        externalTransactionId: 'crucible-prize-1-1-1',
      },
    ]);
  });

  it("links the winner's notification to the prize it awarded", async () => {
    setupCrucible({ entryFee: 100, entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });

    await finalizeCrucible(1);

    const won = createNotification.mock.calls
      .map(([n]) => n)
      .find((n) => n.type === 'crucible-won');
    expect(won.details).toMatchObject({ prizeId: 100, prizeCount: 1 });
  });

  it('leaves a name still under review off the prize', async () => {
    setupCrucible({
      entryFee: 100,
      entries: [dbEntry(1, 10, 1_000)],
      elos: { 1: 1500 },
      ingestion: CrucibleIngestionStatus.Pending,
    });

    await finalizeCrucible(1);

    expect(awarded()).toEqual([expect.objectContaining({ title: 'Crucible 1st prize' })]);
  });

  it.each([
    ['still under review', { ingestion: CrucibleIngestionStatus.Pending }],
    ['flagged as adult text', { textNsfw: true }],
  ])('leaves a name %s out of the notifications', async (_, scan) => {
    setupCrucible({ entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });
    findUnique.mockResolvedValue({ ...(await findUnique()), ...scan });

    await finalizeCrucible(1);

    const sent = createNotification.mock.calls.map(([arg]) => arg);
    expect(sent.map((n) => n.type).sort()).toEqual(['crucible-ended', 'crucible-won']);
    for (const notification of sent) expect(notification.details.crucibleName).toBeNull();
  });

  it('names a crucible whose text passed in the notifications', async () => {
    setupCrucible({ entries: [dbEntry(1, 10, 1_000)], elos: { 1: 1500 } });

    await finalizeCrucible(1);

    const sent = createNotification.mock.calls.map(([arg]) => arg);
    expect(sent).toHaveLength(2);
    for (const notification of sent)
      expect(notification.details.crucibleName).toBe('Test Crucible');
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

    const values = entryWrites().flatMap(([, rows]) => (rows as { values: unknown[] }).values);
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

// Product decision (2026-10-04): a creator takes at most one prize. Their other entries keep their
// positions on the leaderboard, and the next creator takes the prize they would have had. Do not
// "simplify" prizes back to being paid by position.
describe('finalizeCrucible — one prize per creator', () => {
  // User 10 holds the top three scores; users 11, 12 and 13 follow.
  const sweep = [
    dbEntry(1, 10, 1_000),
    dbEntry(2, 10, 2_000),
    dbEntry(3, 10, 3_000),
    dbEntry(4, 11, 4_000),
    dbEntry(5, 12, 5_000),
    dbEntry(6, 13, 6_000),
  ];
  const sweepElos = { 1: 1700, 2: 1650, 3: 1600, 4: 1550, 5: 1500, 6: 1450 };
  const paid = () => awarded().map((prize) => [prize.userId, prize.amount, prize.title]);

  it('pays a creator holding the top three scores one prize, and moves the next creators up', async () => {
    setupCrucible({ entryFee: 100, entries: sweep, elos: sweepElos });

    const result = await finalizeCrucible(1);

    // 50/30/20 of a 600 pool.
    expect(paid()).toEqual([
      [10, 300, 'Crucible 1st prize: Test Crucible'],
      [11, 180, 'Crucible 2nd prize: Test Crucible'],
      [12, 120, 'Crucible 3rd prize: Test Crucible'],
    ]);
    expect(
      result.finalEntries.map((e) => [e.entryId, e.position, e.prizePlace, e.prizeAmount])
    ).toEqual([
      [1, 1, 1, 300],
      [2, 2, null, 0],
      [3, 3, null, 0],
      [4, 4, 2, 180],
      [5, 5, 3, 120],
      [6, 6, null, 0],
    ]);
    expect(result.totalPrizesDistributed).toBe(600);
  });

  it("keeps every position as ranked, including the creator's unpaid entries", async () => {
    setupCrucible({ entryFee: 100, entries: sweep, elos: sweepElos });

    await finalizeCrucible(1);

    const values = entryWrites().flatMap(([, rows]) => (rows as { values: unknown[] }).values);
    // (entryId, score, position, voteCount) per entry.
    const positions = Array.from({ length: 6 }, (_, i) => [values[i * 4], values[i * 4 + 2]]);
    expect(positions).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ]);
  });

  it('tells the creator who moved up which prize they took, alongside their position', async () => {
    setupCrucible({ entryFee: 100, entries: sweep, elos: sweepElos });

    await finalizeCrucible(1);

    const won = (userId: number) =>
      createNotification.mock.calls
        .map(([arg]) => arg)
        .find((arg) => arg.type === 'crucible-won' && arg.userId === userId)?.details;
    expect(won(10)).toMatchObject({ position: 1, prizePlace: 1, prizeAmount: 300 });
    expect(won(11)).toMatchObject({ position: 4, prizePlace: 2, prizeAmount: 180 });
    expect(won(13)).toMatchObject({ position: 6, prizePlace: null, prizeAmount: 0 });
  });

  it('gives a lone creator the whole pool once, as when the places go unfilled', async () => {
    setupCrucible({
      entryFee: 100,
      entries: sweep.slice(0, 3),
      elos: { 1: 1700, 2: 1650, 3: 1600 },
    });

    await finalizeCrucible(1);

    expect(paid()).toEqual([[10, 300, 'Crucible 1st prize: Test Crucible']]);
  });

  it('pays from the stored positions on a retry, one prize per creator', async () => {
    setupCrucible({
      entryFee: 100,
      entries: sweep.map((entry, i) => ({ ...entry, position: i + 1 })),
      elos: { 1: 1400, 2: 1400, 3: 1400, 4: 1700, 5: 1400, 6: 1400 },
    });
    dbMock.dbWrite.crucibleEntry.count.mockResolvedValue(6);

    await finalizeCrucible(1);

    expect(paid().map(([userId, amount]) => [userId, amount])).toEqual([
      [10, 300],
      [11, 180],
      [12, 120],
    ]);
  });
});

describe('finalizeCrucible — followers', () => {
  const follows = dbMock.dbWrite.crucibleEngagement.findMany;
  const results = () =>
    createNotification.mock.calls.map(([arg]) => arg).filter((n) => n.type === 'crucible-results');

  beforeEach(() => {
    follows.mockResolvedValue([]);
    dbMock.dbWrite.userEngagement.findMany.mockResolvedValue([]);
  });

  it('tells followers who are neither the host nor an entrant, once, through the opt-out path', async () => {
    // Host 4 and entrants 10-12 already get crucible-ended / crucible-won.
    follows.mockResolvedValue([10, 4, 50, 12, 51].map((userId) => ({ userId })));

    await finalizeCrucible(1);

    expect(follows).toHaveBeenCalledWith({
      where: { crucibleId: 1, type: 'Notify' },
      select: { userId: true },
    });
    expect(results()).toEqual([
      {
        type: 'crucible-results',
        category: 'Update',
        key: 'crucible-results:1',
        userIds: [50, 51],
        details: { crucibleId: 1, crucibleName: 'Test Crucible' },
      },
    ]);
  });

  it('tells followers of a crucible nobody entered', async () => {
    findUnique.mockResolvedValue({
      ...(await findUnique()),
      _count: { entries: 0 },
    });
    follows.mockResolvedValue([4, 60].map((userId) => ({ userId })));

    await finalizeCrucible(1);

    expect(results().map((n) => n.userIds)).toEqual([[60]]);
  });

  it('sends nothing when every follower already heard', async () => {
    follows.mockResolvedValue([4, 11].map((userId) => ({ userId })));

    await finalizeCrucible(1);

    expect(results()).toEqual([]);
  });

  it('does not notify followers when awarding fails and the crucible stays Active', async () => {
    setupCrucible({ entryFee: 100 });
    createPrizes.mockRejectedValue(new Error('db down'));
    follows.mockResolvedValue([{ userId: 50 }]);

    await expect(finalizeCrucible(1)).rejects.toThrow('db down');

    expect(createPrizes).toHaveBeenCalled();
    expect(results()).toEqual([]);
  });

  it('skips followers on either side of a block with the host, or who hid the host', async () => {
    follows.mockResolvedValue([50, 51, 52].map((userId) => ({ userId })));
    dbMock.dbWrite.userEngagement.findMany.mockResolvedValue([
      { userId: 4, targetUserId: 51 },
      { userId: 52, targetUserId: 4 },
    ]);

    await finalizeCrucible(1);

    expect(dbMock.dbWrite.userEngagement.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: 4, targetUserId: { in: [50, 51, 52] }, type: 'Block' },
          { userId: { in: [50, 51, 52] }, targetUserId: 4, type: { in: ['Block', 'Hide'] } },
        ],
      },
      select: { userId: true, targetUserId: true },
    });
    expect(results().map((n) => n.userIds)).toEqual([[50]]);
  });

  it.each([
    ['its text', { ingestion: CrucibleIngestionStatus.Pending }],
    ['its cover', { image: { ingestion: ImageIngestionStatus.Pending } }],
  ])('tells no follower about a crucible hidden because %s is unscanned', async (_, hidden) => {
    findUnique.mockResolvedValue({ ...(await findUnique()), ...hidden });
    follows.mockResolvedValue([{ userId: 50 }]);

    await finalizeCrucible(1);

    expect(results()).toEqual([]);
    expect(createNotification.mock.calls.map(([n]) => n.type)).toContain('crucible-ended');
  });
});

describe('finalizeCrucible — entry posts', () => {
  const revealQuery = () => {
    const call = dbMock.dbWrite.$queryRaw.mock.calls.find(([strings]) =>
      (strings as string[]).join('').includes('entry_posts')
    );
    if (!call) return undefined;
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    const query = Prisma.sql(strings, ...values);
    return { sql: query.text, values: query.values };
  };

  it("reveals this crucible's entry-modal posts and reindexes each one once it completes", async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: string[]) =>
      strings.join('').includes('entry_posts')
        ? [
            { id: 300, userId: 10 },
            { id: 301, userId: 11 },
          ]
        : []
    );

    await finalizeCrucible(1);

    const query = revealQuery();
    expect(query?.sql).toMatch(
      /UPDATE "Post" p SET "publishedAt" = now\(\)\s+FROM entry_posts e\s+WHERE p\.id = e\.id AND e\.hidden/
    );
    expect(query?.sql).toMatch(/"publishedAt" > now\(\)/);
    expect(query?.sql).toMatch(/ce\."crucibleId" = \$\d/);
    expect(query?.values).toEqual(expect.arrayContaining([1, 'crucibleEntryDraft']));
    expect(afterPostsPublish).toHaveBeenCalledTimes(1);
    expect(afterPostsPublish).toHaveBeenCalledWith([
      { postId: 300, userId: 10 },
      { postId: 301, userId: 11 },
    ]);
  });

  it('reveals nothing when another run already completed it', async () => {
    claim.mockResolvedValue({ count: 0 });

    await finalizeCrucible(1);

    expect(revealQuery()).toBeUndefined();
  });

  it('still completes when the reveal fails, since the clock already published them', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: string[]) => {
      if (strings.join('').includes('entry_posts')) throw new Error('db down');
      return [];
    });

    await expect(finalizeCrucible(1)).resolves.toMatchObject({ crucibleId: 1 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'crucible-entry-posts-reveal-failed', crucibleId: 1 })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { REDIS_KEYS } from '~/server/redis/client';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async () => 0),
}));
const { fetchThroughCache } = await import('~/server/utils/cache-helpers');

const { getUserCrucibleStats } = await import('~/server/services/crucible.service');

const USER_ID = 11;
const prizePositions = { '1': 50, '2': 30, '3': 20 };
const entry = (
  id: number,
  crucibleId: number,
  position: number | null,
  seededPrizePool = 1000,
  status: CrucibleStatus = CrucibleStatus.Completed
) => ({
  id,
  crucibleId,
  position,
  crucible: { status, prizePositions, entryFee: 0, seededPrizePool },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.prize.aggregate.mockResolvedValue({ _sum: { amount: null } });
});

/**
 * `fieldSize` creators placed 1..fieldSize, with the user at `rank`. Listed last place first:
 * the placings query has no ORDER BY, so ranking must not lean on row order.
 */
const placings = (crucibleId: number, rank: number, fieldSize: number) =>
  Array.from({ length: fieldSize }, (_, i) => ({
    crucibleId,
    entryId: crucibleId * 1000 + i,
    userId: i + 1 === rank ? USER_ID : 100 + i,
    position: i + 1,
  })).reverse();

describe('getUserCrucibleStats — crucibles won', () => {
  it('counts a crucible won when the creator took a prize from below the prize positions', async () => {
    // Crucible 1: another creator holds 1st-3rd, so 4th place takes 2nd prize.
    // Crucible 2: three creators finish ahead, so 4th place takes nothing.
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, 4), entry(9, 2, 4)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      { crucibleId: 1, entryId: 1, userId: 10, position: 1 },
      { crucibleId: 1, entryId: 2, userId: 10, position: 2 },
      { crucibleId: 1, entryId: 3, userId: 10, position: 3 },
      { crucibleId: 1, entryId: 4, userId: USER_ID, position: 4 },
      { crucibleId: 2, entryId: 6, userId: 20, position: 1 },
      { crucibleId: 2, entryId: 7, userId: 21, position: 2 },
      { crucibleId: 2, entryId: 8, userId: 22, position: 3 },
      { crucibleId: 2, entryId: 9, userId: USER_ID, position: 4 },
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ cruciblesEntered: 2, cruciblesWon: 1, cruciblesEnded: 2 });
  });

  it('does not count a place whose share of the pool came to 0 Buzz, as finalize pays nothing', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(1, 1, 1, 0)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue(placings(1, 1, 5));

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.cruciblesWon).toBe(0);
  });

  it('counts a prize paid from entry fees alone', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      {
        ...entry(1, 1, 1, 0),
        crucible: {
          status: CrucibleStatus.Completed,
          prizePositions,
          entryFee: 100,
          seededPrizePool: 0,
        },
      },
    ]);
    dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValueOnce([
      { crucibleId: 1, _count: { _all: 5 } },
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue(placings(1, 1, 5));

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.cruciblesWon).toBe(1);
    // The mock answers whatever is selected, so the pool's inputs must be asked for by name.
    expect(dbMock.dbRead.crucibleEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          crucible: {
            select: expect.objectContaining({ entryFee: true, seededPrizePool: true }),
          },
        }),
      })
    );
  });

  it('asks nothing about placings when the creator never placed', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, null)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toEqual({
      cruciblesEntered: 1,
      cruciblesEnded: 1,
      cruciblesWon: 0,
      buzzWon: 0,
      bestFinish: null,
      avgFinishTopPercent: null,
      votesCast: 0,
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('getUserCrucibleStats — average finish', () => {
  it('scores a finish against its own field, so a big crucible does not count against the creator', async () => {
    // Top 10% of 50, top 10% of 10, top 20% of 5: an average of top 13%.
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, 5),
      entry(2, 2, 1),
      entry(3, 3, 1),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      ...placings(1, 5, 50),
      ...placings(2, 1, 10),
      ...placings(3, 1, 5),
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.avgFinishTopPercent).toBe(13);
  });

  // Decided by Justin, 2026-10-05: a crucible where none of your entries placed is skipped, not
  // counted as last place. Changing it changes what the number means; ask before you do.
  it('skips a crucible where the creator entered but did not place', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, 1),
      entry(2, 2, 1),
      entry(3, 3, 1),
      entry(4, 4, null),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      ...placings(1, 1, 10),
      ...placings(2, 1, 10),
      ...placings(3, 1, 10),
      ...placings(4, 0, 50),
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.avgFinishTopPercent).toBe(10);
  });

  it('is not shown until three crucibles with a big enough field count', async () => {
    // The 4-creator crucible is skipped, leaving two that count.
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, 1),
      entry(2, 2, 1),
      entry(3, 3, 1),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      ...placings(1, 1, 10),
      ...placings(2, 1, 10),
      ...placings(3, 1, 4),
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.avgFinishTopPercent).toBeNull();
  });
});

describe('getUserCrucibleStats — participation counts everything, results only ended crucibles', () => {
  it('counts a user whose crucibles are all still running as entered, with no results and no throw', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, null, 1000, CrucibleStatus.Active),
      entry(2, 2, null, 1000, CrucibleStatus.Active),
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({
      cruciblesEntered: 2,
      cruciblesEnded: 0,
      cruciblesWon: 0,
      bestFinish: null,
      avgFinishTopPercent: null,
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('asks for active and ended crucibles only, never cancelled or pending ones', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([]);

    await getUserCrucibleStats({ userId: USER_ID });

    expect(dbMock.dbRead.crucibleEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          crucible: { status: { in: [CrucibleStatus.Active, CrucibleStatus.Completed] } },
        },
      })
    );
  });

  it('counts an active crucible as entered but takes results from the ended one only', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, 3),
      entry(2, 2, null, 1000, CrucibleStatus.Active),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue(placings(1, 3, 10));

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({
      cruciblesEntered: 2,
      cruciblesEnded: 1,
      bestFinish: { position: 3, fieldSize: 10 },
    });
    expect(dbMock.dbRead.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('counts an ended crucible once in the win-rate denominator however many entries', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(1, 1, 1), entry(2, 1, 2)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue(placings(1, 1, 10));

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ cruciblesEntered: 1, cruciblesEnded: 1 });
  });

  it('counts a crucible once however many entries the user put in', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, null, 1000, CrucibleStatus.Active),
      entry(2, 1, null, 1000, CrucibleStatus.Active),
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.cruciblesEntered).toBe(1);
  });
});

describe('getUserCrucibleStats — best finish', () => {
  it('carries the size of the field it was won in, and prefers the better rank', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(1, 1, 2), entry(2, 2, 5)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([...placings(1, 2, 48), ...placings(2, 5, 6)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.bestFinish).toEqual({ position: 2, fieldSize: 48 });
  });

  it('prefers the bigger field when two finishes share a rank', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(1, 1, 2), entry(2, 2, 2)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([...placings(1, 2, 6), ...placings(2, 2, 48)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.bestFinish).toEqual({ position: 2, fieldSize: 48 });
  });

  it('ranks among creators, so a creator holding the places above does not push the user down', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, 3)]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([
      { crucibleId: 1, entryId: 1, userId: 10, position: 1 },
      { crucibleId: 1, entryId: 2, userId: 10, position: 2 },
      { crucibleId: 1, entryId: 4, userId: USER_ID, position: 3 },
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.bestFinish).toEqual({ position: 2, fieldSize: 2 });
  });
});

describe('getUserCrucibleStats — win rate', () => {
  it('is crucibles with a paid prize over ended crucibles entered, leaving running ones out', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      entry(1, 1, 1),
      entry(2, 2, 9),
      entry(3, 3, null),
      entry(4, 4, null, 1000, CrucibleStatus.Active),
    ]);
    dbMock.dbRead.$queryRaw.mockResolvedValue([...placings(1, 1, 10), ...placings(2, 9, 10)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ cruciblesWon: 1, cruciblesEnded: 3, cruciblesEntered: 4 });
  });
});

describe('getUserCrucibleStats — votes cast', () => {
  it('reads the all-time judging vote count', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([]);
    redisMock.sysRedis.hGet.mockResolvedValue('37');

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.votesCast).toBe(37);
    expect(redisMock.sysRedis.hGet).toHaveBeenCalledWith(expect.any(String), String(USER_ID));
  });

  it('shows votes for a judge who has not entered anything', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([]);
    redisMock.sysRedis.hGet.mockResolvedValue('4');

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toMatchObject({ cruciblesEntered: 0, votesCast: 4 });
  });
});

describe('getUserCrucibleStats — buzz won', () => {
  const total = async () => {
    vi.mocked(fetchThroughCache).mockImplementationOnce(async (_key, fetcher) => fetcher());
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([]);
    return (await getUserCrucibleStats({ userId: USER_ID })).buzzWon;
  };

  it("reads and caches under this user's own key", async () => {
    await total();

    expect(fetchThroughCache).toHaveBeenCalledWith(
      `${REDIS_KEYS.CRUCIBLE.USER_BUZZ_WON}:${USER_ID}`,
      expect.any(Function),
      expect.anything()
    );
  });

  it("is the sum of the creator's unvoided crucible prizes, claimed or not", async () => {
    dbMock.dbRead.prize.aggregate.mockResolvedValue({ _sum: { amount: 800 } });

    expect(await total()).toBe(800);
    expect(dbMock.dbRead.prize.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, sourceType: 'Crucible', voidedAt: null },
      })
    );
  });

  it('never queries the BuzzTransaction table, which lives in an external service', async () => {
    await total();

    const sql = dbMock.dbRead.$queryRaw.mock.calls.map(([strings]) =>
      (strings as TemplateStringsArray).join('')
    );
    expect(sql.some((text) => text.includes('BuzzTransaction'))).toBe(false);
  });

  it('is zero, not negative, when nothing was won', async () => {
    expect(await total()).toBe(0);
  });
});

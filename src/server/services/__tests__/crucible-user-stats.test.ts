import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async () => 0),
}));

const { getUserCrucibleStats } = await import('~/server/services/crucible.service');

const USER_ID = 11;
const prizePositions = { '1': 50, '2': 30, '3': 20 };
const entry = (id: number, crucibleId: number, position: number | null) => ({
  id,
  crucibleId,
  position,
  crucible: { prizePositions },
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** `fieldSize` creators placed 1..fieldSize, with the user at `rank`. */
const placings = (crucibleId: number, rank: number, fieldSize: number) =>
  Array.from({ length: fieldSize }, (_, i) => ({
    crucibleId,
    entryId: crucibleId * 1000 + i,
    userId: i + 1 === rank ? USER_ID : 100 + i,
    position: i + 1,
  }));

describe('getUserCrucibleStats — prizes won', () => {
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

    expect(stats).toMatchObject({ totalCrucibles: 2, bestPlacement: 4, prizesWon: 1 });
  });

  it('asks nothing about placings when the creator never placed', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([entry(4, 1, null)]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats).toEqual({
      totalCrucibles: 1,
      buzzWon: 0,
      bestPlacement: null,
      avgFinishTopPercent: null,
      prizesWon: 0,
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

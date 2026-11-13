import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as CacheHelpers from '~/server/utils/cache-helpers';

vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof CacheHelpers>()),
  fetchThroughCache: vi.fn(async () => 0),
}));

const { getCrucibleDetail, getCrucibleEntries, getUserCrucibleStats } = await import(
  '~/server/services/crucible.service'
);

const USER_ID = 11;
const prizePositions = { '1': 50, '2': 30, '3': 20 };
const crucibleRow = {
  id: 1,
  status: CrucibleStatus.Completed,
  userId: 99,
  prizePositions,
  entryFee: 0,
  seededPrizePool: 0,
  textNsfw: false,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  image: { ingestion: 'Scanned' },
  freeEntriesPerUser: 1,
};
// Listed last place first: the placings query has no ORDER BY.
const placed = Array.from({ length: 5 }, (_, i) => ({
  crucibleId: 1,
  entryId: 100 + i,
  userId: i === 0 ? USER_ID : 200 + i,
  position: i + 1,
})).reverse();

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.crucible.findUnique.mockResolvedValue(crucibleRow);
  dbMock.dbRead.crucibleEntry.groupBy.mockResolvedValue([]);
  dbMock.dbRead.prize.aggregate.mockResolvedValue({ _sum: { amount: null } });
  dbMock.dbRead.$queryRaw.mockImplementation(async (strings: string[]) => {
    const sql = strings.join('?');
    if (sql.includes('imageVisible'))
      return placed.slice(-3).map(({ entryId }) => ({ id: entryId, imageVisible: true }));
    if (sql.includes('"entryId"')) return placed;
    if (sql.includes('AS entrants')) return [];
    if (sql.includes('SELECT ce.id')) return [];
    if (sql.includes('AS count')) return [{ count: 0 }];
    throw new Error('unexpected SQL: ' + sql);
  });
});

describe('a crucible with no prize pool', () => {
  it('lists no prize winners on the detail page', async () => {
    const detail = await getCrucibleDetail({ id: 1 });

    expect(detail?.prizeWinners).toEqual([]);
  });

  it('counts no crucible won in the stats', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      { id: 100, crucibleId: 1, position: 1, crucible: crucibleRow },
    ]);

    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(stats.cruciblesWon).toBe(0);
  });

  it('agrees with the stats once a pool pays the places', async () => {
    const funded = { ...crucibleRow, seededPrizePool: 1000 };
    dbMock.dbRead.crucible.findUnique.mockResolvedValue(funded);
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue([
      { id: 100, crucibleId: 1, position: 1, crucible: funded },
    ]);

    const detail = await getCrucibleDetail({ id: 1 });
    const stats = await getUserCrucibleStats({ userId: USER_ID });

    expect(detail?.prizeWinners.map(({ prizePlace }) => prizePlace)).toEqual([1, 2, 3]);
    expect(stats.cruciblesWon).toBe(1);
  });

  it('still lists the podium, which shows placings rather than payouts', async () => {
    dbMock.dbRead.crucibleEntry.findMany.mockResolvedValue(
      placed.slice(-3).map(({ entryId }) => ({ id: entryId, image: null }))
    );

    const { podium } = await getCrucibleEntries({ crucibleId: 1, limit: 10 } as never);

    expect(podium.map(({ prizePlace }) => prizePlace)).toEqual([1, 2, 3]);
  });
});
